import * as React from "react";
import { useSyncExternalStore } from "use-sync-external-store/shim";

// For server-side rendering / react-native
const useIsoLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

export type ValidatorResult<ErrorMessage = string> =
  | ErrorMessage
  | void
  | Promise<ErrorMessage | void>;

export type Validator<Value, ErrorMessage = string> = (
  value: Value,
) => ValidatorResult<ErrorMessage>;

export type FormStatus = "untouched" | "editing" | "submitting" | "submitted";

// Kudos to https://github.com/MinimaHQ/re-formality/blob/master/docs/02-ValidationStrategies.md
export type Strategy = "onChange" | "onSuccess" | "onBlur" | "onSuccessOrBlur" | "onSubmit";

export type FieldState<Value, ErrorMessage = string> = {
  value: Value;
  validating: boolean;
  valid: boolean;
  error: ErrorMessage | undefined;
};

export type FormConfig<Values extends Record<string, unknown>, ErrorMessage = string> = {
  [N in keyof Values]: {
    initialValue: Values[N] | (() => Values[N]);
    defaultValue?: Values[N];
    optional?: boolean;
    strategy?: Strategy;
    debounceInterval?: number;
    equalityFn?: (valueBeforeValidate: Values[N], valueAfterValidate: Values[N]) => boolean;
    sanitize?: (value: Values[N]) => Values[N];
    validate?: (
      value: Values[N],
      helpers: {
        focusField: (name: keyof Values) => void;
        getFieldState: <N extends keyof Values>(
          name: N,
          options?: { sanitize?: boolean },
        ) => FieldState<Values[N], ErrorMessage>;
      },
    ) => ValidatorResult<ErrorMessage>;
  };
};

export type Form<Values extends Record<string, unknown>, ErrorMessage = string> = {
  formStatus: FormStatus;

  Field: (<N extends keyof Values>(props: {
    name: N;
    children: (
      props: FieldState<Values[N], ErrorMessage> & {
        ref: React.MutableRefObject<any>;
        onChange: (value: Values[N]) => void;
        onBlur: () => void;
        focusNextField: () => void;
      },
    ) => React.ReactElement | null;
  }) => React.ReactElement | null) & {
    displayName?: string;
  };

  FieldsListener: (<N extends keyof Values>(props: {
    names: N[];
    children: (states: {
      [N1 in N]: FieldState<Values[N1], ErrorMessage>;
    }) => React.ReactElement | null;
  }) => React.ReactElement | null) & {
    displayName?: string;
  };

  getFieldState: <N extends keyof Values>(
    name: N,
    options?: { sanitize?: boolean },
  ) => FieldState<Values[N], ErrorMessage>;
  setFieldValue: <N extends keyof Values>(
    name: N,
    value: Values[N],
    options?: { validate?: boolean },
  ) => void;

  focusField: (name: keyof Values) => void;
  resetField: (name: keyof Values) => void;
  validateField: (name: keyof Values) => Promise<ErrorMessage | void>;

  listenFields: <N extends keyof Values>(
    names: N[],
    listener: (states: { [N1 in N]: FieldState<Values[N1], ErrorMessage> }) => void,
  ) => () => void;

  resetForm: () => void;
  submitForm: (
    onSuccess: (values: Partial<Values>) => Promise<unknown> | void,
    onFailure?: (errors: Partial<Record<keyof Values, ErrorMessage>>) => Promise<unknown> | void,
    options?: { avoidFocusOnError?: boolean },
  ) => void;
};

const identity = <T>(value: T) => value;
const noop = () => {};

const extractInitialValue = <Value>(value: Value | (() => Value)): Value =>
  typeof value === "function" ? (value as () => Value)() : value;

const isPromise = <T>(value: unknown): value is Promise<T> =>
  !!value &&
  (typeof value === "object" || typeof value === "function") &&
  typeof (value as { then?: Function }).then === "function";

export const combineValidators =
  <Value, ErrorMessage = string>(
    ...validators: (Validator<Value, ErrorMessage> | false)[]
  ): Validator<Value, ErrorMessage> =>
  (value) => {
    const [validator, ...nextValidators] = validators;

    if (validator) {
      const result = validator(value);

      if (isPromise(result)) {
        return result.then((error) => {
          if (typeof error !== "undefined") {
            return error;
          }
          if (nextValidators.length > 0) {
            return combineValidators(...nextValidators)(value);
          }
        });
      }

      if (typeof result !== "undefined") {
        return result;
      }
    }

    if (nextValidators.length > 0) {
      return combineValidators(...nextValidators)(value);
    }
  };

export const hasDefinedKeys = <T extends Record<string, unknown>, K extends keyof T = keyof T>(
  object: T,
  keys: K[],
): object is T & {
  [K1 in K]-?: Exclude<T[K1], undefined>;
} => keys.every((key) => typeof object[key] !== "undefined");

export const useForm = <Values extends Record<string, unknown>, ErrorMessage = string>(
  fields: FormConfig<Values, ErrorMessage>,
): Form<Values, ErrorMessage> => {
  type Contract = Form<Values, ErrorMessage>;
  type Name = keyof Values;

  const [, forceUpdate] = React.useReducer(() => [], []);
  const mounted = React.useRef(false);
  const config = React.useRef(fields);
  const formStatus = React.useRef<FormStatus>("untouched");

  useIsoLayoutEffect(() => {
    config.current = fields;
  });

  React.useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  type StateMap = {
    [N in Name]: Readonly<{
      exposed: FieldState<Values[N], ErrorMessage>;
      talkative: boolean;
      validity:
        | { readonly tag: "unknown" }
        | { readonly tag: "validating" }
        | { readonly tag: "valid" }
        | { readonly tag: "invalid"; error: ErrorMessage };
    }>;
  };

  const states = React.useRef() as React.MutableRefObject<StateMap>;

  type CallbackMap = Record<Name, Set<() => void>>;
  type MountedMap = Record<Name, boolean>;
  type RefMap = Record<Name, React.MutableRefObject<any>>;
  type TimeoutMap = Record<Name, number | undefined>;

  const callbacks = React.useRef() as React.MutableRefObject<CallbackMap>;
  const mounteds = React.useRef() as React.MutableRefObject<MountedMap>;
  const refs = React.useRef() as React.MutableRefObject<RefMap>;
  const timeouts = React.useRef() as React.MutableRefObject<TimeoutMap>;

  const field = React.useRef() as React.MutableRefObject<Contract["Field"]>;
  const fieldsListener = React.useRef() as React.MutableRefObject<Contract["FieldsListener"]>;

  const api = React.useMemo(() => {
    const getDebounceInterval = (name: Name) => config.current[name].debounceInterval ?? 0;
    const getEqualityFn = (name: Name) => config.current[name].equalityFn ?? Object.is;
    const getInitialValue = (name: Name) => extractInitialValue(config.current[name].initialValue);
    const getSanitize = (name: Name) => config.current[name].sanitize ?? identity;
    const getStrategy = (name: Name) => config.current[name].strategy ?? "onSuccessOrBlur";
    const getValidate = (name: Name) => config.current[name].validate ?? noop;

    const isOptional = (name: Name) => Boolean(config.current[name].optional);
    const isMounted = (name: Name) => mounteds.current[name];
    const isTalkative = (name: Name) => states.current[name].talkative;

    const isDefaultValue = <N extends Name>(name: Name, value: Values[N]): boolean =>
      Object.prototype.hasOwnProperty.call(config.current[name], "defaultValue")
        ? value === config.current[name].defaultValue
        : false;

    const setState = <N extends Name>(
      name: N,
      state: React.SetStateAction<
        { value: Values[N] } & Pick<StateMap[N], "talkative" | "validity">
      >,
    ) => {
      const currentState = states.current[name];

      const nextState =
        typeof state === "function"
          ? state({
              value: currentState.exposed.value,
              talkative: currentState.talkative,
              validity: currentState.validity,
            })
          : state;

      const exposed =
        !nextState.talkative || nextState.validity.tag === "unknown"
          ? // Avoid giving feedback too soon
            {
              validating: false,
              valid: !getValidate(name),
              error: undefined,
            }
          : {
              validating: nextState.validity.tag === "validating",
              valid: nextState.validity.tag === "valid",
              error: nextState.validity.tag === "invalid" ? nextState.validity.error : undefined,
            };

      states.current[name] = {
        talkative: nextState.talkative,
        validity: nextState.validity,
        exposed: { ...exposed, value: nextState.value },
      };
    };

    const clearDebounceTimeout = (name: Name): boolean => {
      const timeout = timeouts.current[name];
      const debounced = typeof timeout !== "undefined";

      if (debounced) {
        clearTimeout(timeout);
        timeouts.current[name] = undefined;
      }

      return debounced;
    };

    const runCallbacks = (name: Name): void => {
      callbacks.current[name].forEach((callback) => callback());
    };

    const setTalkativeStatus = <N extends Name>(name: N, strategies?: Strategy[]): boolean => {
      if (isOptional(name) && isDefaultValue(name, states.current[name].exposed.value)) {
        setState(name, (prevState) => ({
          ...prevState,
          talkative: false,
        }));
      } else {
        const strategy = getStrategy(name);

        if (!strategies || strategies.some((item) => strategy === item)) {
          setState(name, (prevState) => ({
            ...prevState,
            talkative: true,
          }));

          return true;
        }
      }

      return false;
    };

    const setValidating = (name: Name): void => {
      setState(name, (prevState) => ({
        ...prevState,
        validity: { tag: "validating" },
      }));
    };

    const setValidateResult = (name: Name, error: ErrorMessage | void): void => {
      setState(name, (prevState) => ({
        ...prevState,
        validity: typeof error !== "undefined" ? { tag: "invalid", error } : { tag: "valid" },
      }));
    };

    const getFieldState = <N extends Name>(
      name: N,
      options: { sanitize?: boolean } = {},
    ): FieldState<Values[N], ErrorMessage> => {
      const { exposed } = states.current[name];

      if (!options.sanitize) {
        return exposed;
      }

      const sanitize = getSanitize(name);

      return {
        ...exposed,
        value: sanitize(exposed.value) as Values[N],
      };
    };

    const internalValidateField = <N extends Name>(name: N): ValidatorResult<ErrorMessage> => {
      const debounced = clearDebounceTimeout(name);

      const sanitizeAtStart = getSanitize(name);
      const validate = getValidate(name);
      const valueAtStart = sanitizeAtStart(states.current[name].exposed.value);

      const promiseOrError = validate(valueAtStart, {
        getFieldState,
        focusField,
      });

      if (!isPromise(promiseOrError)) {
        const error = promiseOrError;

        if (error === undefined) {
          setTalkativeStatus(name, ["onSuccess", "onSuccessOrBlur"]);
        }

        setValidateResult(name, error);
        runCallbacks(name);

        return error;
      }

      if (!debounced) {
        setValidating(name);
        runCallbacks(name);
      }

      return promiseOrError
        .then((error) => {
          const equalityFn = getEqualityFn(name);
          const valueAtEnd = sanitizeAtStart(states.current[name].exposed.value);

          if (!equalityFn(valueAtStart, valueAtEnd)) {
            return;
          }
          if (error === undefined) {
            setTalkativeStatus(name, ["onSuccess", "onSuccessOrBlur"]);
          }

          setValidateResult(name, error);
          runCallbacks(name);

          return error;
        })
        .catch((error) => {
          if (process.env.NODE_ENV === "development") {
            console.error(
              `Something went wrong during "${String(
                name,
              )}" validation. Don't forget to handle Promise rejection.\n`,
              error,
            );
          }
        });
    };

    const setFieldValue: Contract["setFieldValue"] = (name, value, options = {}) => {
      setState(name, (prevState) => ({
        ...prevState,
        value,
      }));

      if (Boolean(options.validate)) {
        setTalkativeStatus(name);
      }

      void internalValidateField(name);
    };

    const focusField: Contract["focusField"] = (name) => {
      const ref = refs.current[name];

      if (ref.current && typeof ref.current.focus === "function") {
        ref.current.focus();
      }
    };

    const resetField: Contract["resetField"] = (name) => {
      clearDebounceTimeout(name);

      setState(name, {
        value: getInitialValue(name),
        talkative: false,
        validity: { tag: "unknown" },
      });

      runCallbacks(name);
    };

    const validateField: Contract["validateField"] = (name) => {
      if (!isMounted(name)) {
        return Promise.resolve(undefined);
      }

      setTalkativeStatus(name);
      return Promise.resolve(internalValidateField(name));
    };

    const listenFields: Contract["listenFields"] = (names, listener) => {
      const callback = () => {
        listener(
          names.reduce(
            (acc, name) => {
              acc[name] = states.current[name].exposed;
              return acc;
            },
            {} as {
              [N1 in typeof names[number]]: FieldState<Values[N1], ErrorMessage>;
            },
          ),
        );
      };

      names.forEach((name) => callbacks.current[name].add(callback));

      return () => {
        names.forEach((name) => callbacks.current[name].delete(callback));
      };
    };

    const getOnChange =
      <N extends Name>(name: N) =>
      (value: Values[N]): void => {
        const debounceInterval = getDebounceInterval(name);

        setState(name, (prevState) => ({
          ...prevState,
          value,
        }));

        setTalkativeStatus(name, ["onChange"]);
        clearDebounceTimeout(name);

        if (formStatus.current === "untouched" || formStatus.current === "submitted") {
          formStatus.current = "editing";
          forceUpdate();
        }

        if (debounceInterval === 0) {
          void internalValidateField(name);
          return;
        }

        setValidating(name);
        runCallbacks(name);

        timeouts.current[name] = setTimeout(() => {
          if (isMounted(name)) {
            void internalValidateField(name);
          } else {
            clearDebounceTimeout(name);
          }
        }, debounceInterval) as unknown as number;
      };

    const getOnBlur = (name: Name) => (): void => {
      const { validity } = states.current[name];

      // Avoid validating an untouched / already valid field
      if (validity.tag !== "unknown" && !isTalkative(name)) {
        setTalkativeStatus(name, ["onBlur", "onSuccessOrBlur"]);
        void internalValidateField(name);
      }
    };

    const getFocusNextField = (name: Name) => () => {
      const keys: Name[] = Object.keys(config.current);
      const index = keys.findIndex((key) => key === name);

      if (typeof index !== "undefined") {
        const nextField = keys[index + 1];

        if (typeof nextField !== "undefined") {
          focusField(nextField);
        }
      }
    };

    const resetForm: Contract["resetForm"] = () => {
      Object.keys(config.current).forEach(resetField);
      formStatus.current = "untouched";
      forceUpdate();
    };

    const isSyncSubmission = (
      results: ValidatorResult<ErrorMessage>[],
    ): results is (ErrorMessage | undefined)[] => results.every((result) => !isPromise(result));

    const focusFirstError = (names: Name[], results: (ErrorMessage | undefined)[]) => {
      const index = results.findIndex((result) => typeof result !== "undefined");
      const name = names[index];
      name && focusField(name);
    };

    const handleSyncEffect = (effect: Promise<unknown> | void, wasEditing: boolean) => {
      if (isPromise(effect)) {
        forceUpdate();

        effect.finally(() => {
          formStatus.current = "submitted";
          mounted.current && forceUpdate();
        });
      } else {
        formStatus.current = "submitted";
        wasEditing && forceUpdate(); // Only needed to rerender and switch from editing to submitted
      }
    };

    const submitForm: Contract["submitForm"] = (onSuccess, onFailure = noop, options = {}) => {
      if (formStatus.current === "submitting") {
        return; // Avoid concurrent submissions
      }

      const wasEditing = formStatus.current === "editing";
      formStatus.current = "submitting";

      const names: Name[] = Object.keys(mounteds.current).filter((name) => mounteds.current[name]);
      const values: Partial<Values> = {};
      const errors: Partial<Record<Name, ErrorMessage>> = {};
      const results: ValidatorResult<ErrorMessage>[] = [];

      // autofocusing first error is the default behaviour
      const shouldFocusOnError = !options.avoidFocusOnError;

      names.forEach((name: Name, index) => {
        const talkative = setTalkativeStatus(name);
        const result = internalValidateField(name);

        if (talkative) {
          values[name] = getFieldState(name, { sanitize: true }).value;
          results[index] = result;
        }
      });

      if (isSyncSubmission(results)) {
        if (results.every((result) => result === undefined)) {
          return handleSyncEffect(onSuccess(values), wasEditing);
        }
        if (shouldFocusOnError) {
          focusFirstError(names, results);
        }

        names.forEach((name, index) => {
          errors[name] = results[index];
        });

        return handleSyncEffect(onFailure(errors), wasEditing);
      }

      forceUpdate(); // Async validation flow: we need to give visual feedback

      Promise.all(results.map((result) => Promise.resolve(result)))
        .then((uncasted) => {
          const results = uncasted as (ErrorMessage | undefined)[];

          if (results.every((result) => result === undefined)) {
            return onSuccess(values);
          }
          if (shouldFocusOnError) {
            focusFirstError(names, results);
          }

          names.forEach((name, index) => {
            errors[name] = results[index];
          });

          return onFailure(errors);
        })
        .finally(() => {
          formStatus.current = "submitted";
          mounted.current && forceUpdate();
        });
    };

    return {
      getFieldState,
      setFieldValue,
      focusField,
      resetField,
      validateField,
      listenFields,
      resetForm,
      submitForm,

      setState,
      getOnChange,
      getOnBlur,
      getFocusNextField,
    };
  }, []);

  // Lazy initialization
  if (!states.current) {
    states.current = {} as StateMap;

    callbacks.current = {} as CallbackMap;
    mounteds.current = {} as MountedMap;
    refs.current = {} as RefMap;
    timeouts.current = {} as TimeoutMap;

    for (const name in config.current) {
      if (Object.prototype.hasOwnProperty.call(config.current, name)) {
        api.setState(name, {
          value: extractInitialValue(config.current[name].initialValue),
          talkative: false,
          validity: { tag: "unknown" },
        });

        callbacks.current[name] = new Set();
        mounteds.current[name] = false;
        refs.current[name] = { current: null };
        timeouts.current[name] = undefined;
      }
    }

    const Field: Contract["Field"] = ({ name, children }) => {
      const { subscribe, getSnapshot } = React.useMemo(
        () => ({
          getSnapshot: () => states.current[name],
          subscribe: (callback: () => void): (() => void) => {
            callbacks.current[name].add(callback);

            return () => {
              callbacks.current[name].delete(callback);
            };
          },
        }),
        [name],
      );

      useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

      React.useEffect(() => {
        const isFirstMounting = !mounteds.current[name];

        if (isFirstMounting) {
          mounteds.current[name] = true;
        } else {
          if (process.env.NODE_ENV === "development") {
            console.error(
              "Mounting multiple fields with identical names is not supported and will lead to errors",
            );
          }
        }

        return () => {
          if (isFirstMounting) {
            mounteds.current[name] = false;
          }
        };
      }, [name]);

      return children({
        ...states.current[name].exposed,
        ref: refs.current[name],
        focusNextField: React.useMemo(() => api.getFocusNextField(name), [name]),
        onBlur: React.useMemo(() => api.getOnBlur(name), [name]),
        onChange: React.useMemo(() => api.getOnChange(name), [name]),
      });
    };

    Field.displayName = "Field";
    field.current = Field;

    const FieldsListener: Contract["FieldsListener"] = ({ names, children }) => {
      const { subscribe, getSnapshot } = React.useMemo(
        () => ({
          getSnapshot: () => JSON.stringify(names.map((name) => states.current[name])),
          subscribe: (callback: () => void): (() => void) => {
            names.forEach((name) => callbacks.current[name].add(callback));

            return () => {
              names.forEach((name) => callbacks.current[name].delete(callback));
            };
          },
        }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [JSON.stringify(names)],
      );

      useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

      return children(
        names.reduce(
          (acc, name) => {
            acc[name] = states.current[name].exposed;
            return acc;
          },
          {} as {
            [N1 in typeof names[number]]: FieldState<Values[N1], ErrorMessage>;
          },
        ),
      );
    };

    FieldsListener.displayName = "FieldsListener";
    fieldsListener.current = FieldsListener;
  }

  return {
    formStatus: formStatus.current,

    Field: field.current,
    FieldsListener: fieldsListener.current,

    getFieldState: api.getFieldState,
    setFieldValue: api.setFieldValue,
    focusField: api.focusField,
    resetField: api.resetField,
    validateField: api.validateField,
    listenFields: api.listenFields,

    resetForm: api.resetForm,
    submitForm: api.submitForm,
  };
};
