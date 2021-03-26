import * as React from "react";
import { useSubscription } from "use-subscription";

// For server-side rendering / react-native
const useIsoLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

type ValidateResult<ErrorMessage> = ErrorMessage | void | Promise<ErrorMessage | void>;

type Helpers<Values extends Record<string, any>, ErrorMessage> = {
  getFieldState: <N extends keyof Values>(
    name: N,
    options?: { sanitize?: boolean },
  ) => FieldState<Values[N], ErrorMessage>;

  focusField: (name: keyof Values) => void;
};

export type FormStatus = "untouched" | "editing" | "submitting" | "submitted";

// Kudos to https://github.com/MinimaHQ/re-formality/blob/master/docs/02-ValidationStrategies.md
export type Strategy =
  | "onFirstChange"
  | "onFirstSuccess"
  | "onFirstBlur"
  | "onFirstSuccessOrFirstBlur"
  | "onSubmit";

export type FieldState<Value, ErrorMessage = string> = {
  value: Value;
  validating: boolean;
  valid: boolean;
  error: ErrorMessage | undefined;
};

type FieldComponent<Values extends Record<string, any>, ErrorMessage = string> = (<
  N extends keyof Values
>(props: {
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

export type FormConfig<Values extends Record<string, any>, ErrorMessage = string> = {
  [N in keyof Values]: {
    initialValue: Values[N];
    strategy?: Strategy;
    debounceInterval?: number;
    equalityFn?: (value1: Values[N], value2: Values[N]) => boolean;
    sanitize?: (value: Values[N]) => Values[N];
    validate?: (
      value: Values[N],
      helpers: Helpers<Values, ErrorMessage>,
    ) => ValidateResult<ErrorMessage>;
  };
};

export type Form<Values extends Record<string, any>, ErrorMessage = string> = {
  formStatus: FormStatus;
  Field: FieldComponent<Values, ErrorMessage>;

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

  resetForm: () => void;
  submitForm: (
    onSuccess: (values: Partial<Values>) => Promise<void> | void,
    onFailure?: (errors: Partial<Record<keyof Values, ErrorMessage>>) => Promise<void> | void,
  ) => void;
};

const identity = <T>(value: T) => value;
const noop = () => {};

const isPromise = <T>(value: any): value is Promise<T> =>
  !!value &&
  (typeof value === "object" || typeof value === "function") &&
  typeof value.then === "function";

export const useForm = <Values extends Record<string, any>, ErrorMessage = string>(
  fields: FormConfig<Values, ErrorMessage>,
): Form<Values, ErrorMessage> => {
  type Contract = Form<Values, ErrorMessage>;
  type Name = keyof Values;

  const [, forceUpdate] = React.useReducer(() => [], []);
  const config = React.useRef(fields);
  const formStatus = React.useRef<FormStatus>("untouched");

  useIsoLayoutEffect(() => {
    config.current = fields;
  });

  type StateMap = {
    [N in Name]: {
      readonly value: Values[N];
      readonly talkative: boolean;
      readonly validity:
        | { readonly type: "unknown" }
        | { readonly type: "validating" }
        | { readonly type: "valid" }
        | { readonly type: "invalid"; error: ErrorMessage };
    };
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

  const field = React.useRef() as React.MutableRefObject<FieldComponent<Values, ErrorMessage>>;

  const api = React.useMemo(() => {
    const getConfig = (name: Name) => config.current[name];

    const getDebounceInterval = (name: Name) => getConfig(name).debounceInterval ?? 0;
    const getEqualityFn = (name: Name) => getConfig(name).equalityFn ?? Object.is;
    const getInitialValue = (name: Name) => getConfig(name).initialValue;
    const getSanitize = (name: Name) => getConfig(name).sanitize ?? identity;
    const getStrategy = (name: Name) => getConfig(name).strategy ?? "onFirstSuccessOrFirstBlur";
    const getValidate = (name: Name) => getConfig(name).validate ?? noop;

    const isMounted = (name: Name) => mounteds.current[name];
    const isTalkative = (name: Name) => states.current[name].talkative;

    const transformState = <N extends Name>(
      name: N,
      state: StateMap[N],
      { sanitize = false }: { sanitize?: boolean },
    ): FieldState<Values[N], ErrorMessage> => {
      const value = (sanitize ? getSanitize(name)(state.value) : state.value) as Values[N];
      const { talkative, validity } = state;

      return !talkative || validity.type === "unknown"
        ? // Avoid giving feedback too soon
          { value, validating: false, valid: !getValidate(name), error: undefined }
        : {
            value,
            validating: validity.type === "validating",
            valid: validity.type === "valid",
            error: validity.type === "invalid" ? validity.error : undefined,
          };
    };

    const clearDebounceTimeout = (name: Name): boolean => {
      const timeout = timeouts.current[name];
      const debounced = timeout != null;

      if (debounced) {
        clearTimeout(timeout);
        timeouts.current[name] = undefined;
      }

      return debounced;
    };

    const runCallbacks = (name: Name): void => {
      callbacks.current[name].forEach((callback) => callback());
    };

    const setTalkative = (name: Name, strategies?: Strategy[]): void => {
      const strategy = getStrategy(name);

      if (!strategies || strategies.some((value) => strategy === value)) {
        states.current[name] = {
          ...states.current[name],
          talkative: true,
        };
      }
    };

    const setValidating = (name: Name): void => {
      states.current[name] = {
        ...states.current[name],
        validity: { type: "validating" },
      };
    };

    const setValidateResult = (name: Name, error: ErrorMessage | void): void => {
      states.current[name] = {
        ...states.current[name],
        validity: error != null ? { type: "invalid", error } : { type: "valid" },
      };
    };

    const getFieldState: Contract["getFieldState"] = (name, options = {}) =>
      transformState(name, states.current[name], options);

    const internalValidateField = <N extends Name>(name: N): ValidateResult<ErrorMessage> => {
      const debounced = clearDebounceTimeout(name);

      const sanitizeAtStart = getSanitize(name);
      const validate = getValidate(name);
      const valueAtStart = sanitizeAtStart(states.current[name].value);
      const promiseOrError = validate(valueAtStart, {
        getFieldState,
        focusField,
      });

      if (!isPromise(promiseOrError)) {
        const error = promiseOrError;

        if (error == null) {
          setTalkative(name, ["onFirstSuccess", "onFirstSuccessOrFirstBlur"]);
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
          const valueAtEnd = sanitizeAtStart(states.current[name].value);

          if (!equalityFn(valueAtStart, valueAtEnd)) {
            return;
          }
          if (error == null) {
            setTalkative(name, ["onFirstSuccess", "onFirstSuccessOrFirstBlur"]);
          }

          setValidateResult(name, error);
          runCallbacks(name);

          return error;
        })
        .catch((error) => {
          if (process.env.NODE_ENV === "development") {
            console.error(
              `Something went wrong during "${name}" validation. Don't forget to handle Promise rejection.\n`,
              error,
            );
          }
        });
    };

    const setFieldValue: Contract["setFieldValue"] = (name, value, options = {}) => {
      states.current[name] = {
        ...states.current[name],
        value,
      };

      if (Boolean(options.validate)) {
        setTalkative(name);
      }

      internalValidateField(name);
    };

    const focusField: Contract["focusField"] = (name) => {
      const ref = refs.current[name];

      if (ref.current && typeof ref.current.focus === "function") {
        ref.current.focus();
      }
    };

    const resetField: Contract["resetField"] = (name) => {
      clearDebounceTimeout(name);

      states.current[name] = {
        value: getInitialValue(name),
        talkative: false,
        validity: { type: "unknown" },
      };

      runCallbacks(name);
    };

    const validateField: Contract["validateField"] = (name) => {
      setTalkative(name);
      return Promise.resolve(isMounted(name) ? internalValidateField(name) : undefined);
    };

    const getOnChange = <N extends Name>(name: N) => (value: Values[N]): void => {
      const debounceInterval = getDebounceInterval(name);

      states.current[name] = {
        ...states.current[name],
        value,
      };

      setTalkative(name, ["onFirstChange"]);

      if (!isMounted(name)) {
        return; // Skip validation
      }

      clearDebounceTimeout(name);

      if (formStatus.current === "untouched") {
        formStatus.current = "editing";
        forceUpdate();
      }

      if (debounceInterval === 0) {
        internalValidateField(name);
        return;
      }

      setValidating(name);
      runCallbacks(name);

      timeouts.current[name] = (setTimeout(() => {
        if (isMounted(name)) {
          internalValidateField(name);
        } else {
          clearDebounceTimeout(name);
        }
      }, debounceInterval) as unknown) as number;
    };

    const getOnBlur = (name: Name) => (): void => {
      if (isTalkative(name)) {
        return; // Avoid validating a field validated on each change
      }

      setTalkative(name, ["onFirstBlur", "onFirstSuccessOrFirstBlur"]);

      if (isMounted(name)) {
        internalValidateField(name);
      }
    };

    const getFocusNextField = (name: Name) => () => {
      const keys: Name[] = Object.keys(config.current);
      const index = keys.findIndex((key) => key === name);

      if (index != null) {
        const nextField = keys[index + 1];
        nextField != null && focusField(nextField);
      }
    };

    const resetForm: Contract["resetForm"] = () => {
      Object.keys(config.current).forEach(resetField);
      formStatus.current = "untouched";
      forceUpdate();
    };

    const isSyncSubmission = (
      results: ValidateResult<ErrorMessage>[],
    ): results is (ErrorMessage | undefined)[] => results.every((result) => !isPromise(result));

    const focusFirstError = (names: Name[], results: (ErrorMessage | undefined)[]) => {
      const index = results.findIndex((result) => result != null);
      const name = names[index];
      name && focusField(name);
    };

    const handleSyncEffect = (effect: Promise<void> | void) => {
      if (isPromise(effect)) {
        forceUpdate();

        effect.finally(() => {
          formStatus.current = "submitted";
          forceUpdate();
        });
      } else {
        formStatus.current = "submitted";
      }
    };

    const submitForm: Contract["submitForm"] = (onSuccess, onFailure = noop) => {
      if (formStatus.current === "submitting") {
        return; // Avoid concurrent submissions
      }

      formStatus.current = "submitting";

      const names: Name[] = Object.keys(mounteds.current);
      const values: Partial<Values> = {};
      const errors: Partial<Record<Name, ErrorMessage>> = {};
      const results: ValidateResult<ErrorMessage>[] = [];

      names.forEach((name: Name, index) => {
        setTalkative(name);
        values[name] = getFieldState(name, { sanitize: true }).value;
        results[index] = internalValidateField(name);
      });

      if (isSyncSubmission(results)) {
        if (results.every((result) => result == null)) {
          return handleSyncEffect(onSuccess(values));
        }

        focusFirstError(names, results);
        names.forEach((name, index) => (errors[name] = results[index]));
        return handleSyncEffect(onFailure(errors));
      }

      forceUpdate(); // Async validation flow: we need to give visual feedback

      Promise.all(results.map((result) => Promise.resolve(result)))
        .then((uncasted) => {
          const results = uncasted as (ErrorMessage | undefined)[];

          if (results.every((result) => result == null)) {
            return onSuccess(values);
          }

          focusFirstError(names, results);
          names.forEach((name, index) => (errors[name] = results[index]));
          return onFailure(errors);
        })
        .finally(() => {
          formStatus.current = "submitted";
          forceUpdate();
        });
    };

    return {
      getFieldState,
      setFieldValue,
      focusField,
      resetField,
      validateField,
      resetForm,
      submitForm,

      transformState,
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
        states.current[name] = {
          value: config.current[name].initialValue,
          talkative: false,
          validity: { type: "unknown" },
        };

        callbacks.current[name] = new Set();
        mounteds.current[name] = false;
        refs.current[name] = { current: null };
        timeouts.current[name] = undefined;
      }
    }

    const Field: FieldComponent<Values, ErrorMessage> = ({ name, children }) => {
      const state = useSubscription(
        React.useMemo(
          () => ({
            getCurrentValue: () => states.current[name],
            subscribe: (callback) => {
              callbacks.current[name].add(callback);

              return () => {
                callbacks.current[name].delete(callback);
              };
            },
          }),
          [name],
        ),
      );

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
        ...api.transformState(name, state, { sanitize: false }),
        ref: refs.current[name],
        focusNextField: React.useMemo(() => api.getFocusNextField(name), [name]),
        onBlur: React.useMemo(() => api.getOnBlur(name), [name]),
        onChange: React.useMemo(() => api.getOnChange(name), [name]),
      });
    };

    Field.displayName = "Field";
    field.current = Field;
  }

  return {
    formStatus: formStatus.current,
    Field: field.current,

    getFieldState: api.getFieldState,
    setFieldValue: api.setFieldValue,
    focusField: api.focusField,
    resetField: api.resetField,
    validateField: api.validateField,

    resetForm: api.resetForm,
    submitForm: api.submitForm,
  };
};
