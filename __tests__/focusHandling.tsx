import { fireEvent, render } from "@testing-library/react";
import * as React from "react";
import { useForm } from "../src";

test("the first errored field is focused after submission", async () => {
  const Test = () => {
    const { Field, resetForm, submitForm } = useForm({
      firstName: {
        strategy: "onSubmit",
        initialValue: "",
        validate: (value) => {
          if (value.length < 3) {
            return "Must be at least 3 characters";
          }
        },
      },
      lastName: {
        strategy: "onSubmit",
        initialValue: "",
        validate: (value) => {
          if (value.length < 3) {
            return "Must be at least 3 characters";
          }
        },
      },
    });

    return (
      <form onSubmit={(e) => e.preventDefault()}>
        <Field name="firstName">
          {({ ref, error, onBlur, onChange, valid, validating, value }) => (
            <>
              <label htmlFor="firstName">First name</label>

              <input
                type="text"
                id="firstName"
                ref={ref}
                value={value}
                onBlur={onBlur}
                onChange={(e) => {
                  e.preventDefault();
                  onChange(e.target.value);
                }}
              />

              {!(valid || error) && <div>firstName idle</div>}
              {valid && <div>firstName valid</div>}
              {validating && <div>firstName validating</div>}
              {error && <div>firstName error</div>}
            </>
          )}
        </Field>

        <Field name="lastName">
          {({ ref, error, onBlur, onChange, valid, validating, value }) => (
            <>
              <label htmlFor="lastName">Last name</label>

              <input
                type="text"
                id="lastName"
                ref={ref}
                value={value}
                onBlur={onBlur}
                onChange={(e) => {
                  e.preventDefault();
                  onChange(e.target.value);
                }}
              />

              {!(valid || error) && <div>lastName idle</div>}
              {valid && <div>lastName valid</div>}
              {validating && <div>lastName validating</div>}
              {error && <div>lastName error</div>}
            </>
          )}
        </Field>

        <button onClick={(e) => resetForm()}>Reset</button>
        <button onClick={(e) => submitForm((values) => {})}>Submit</button>
      </form>
    );
  };

  const { findByLabelText, findByText } = render(<Test />);

  const firstNameInput = await findByLabelText("First name");
  const lastNameInput = await findByLabelText("Last name");

  const submitButton = await findByText("Submit");

  fireEvent.input(firstNameInput, { target: { value: "Nicolas" } });
  fireEvent.input(lastNameInput, { target: { value: "Ni" } });

  fireEvent.click(submitButton);

  await findByText("firstName valid");
  await findByText("lastName error");

  expect(lastNameInput).toHaveFocus();
});

test("focusField and focusNextField behave like expected", async () => {
  const Test = () => {
    const { Field, focusField } = useForm({
      firstName: { initialValue: "" },
      lastName: { initialValue: "" },
    });

    return (
      <form onSubmit={(e) => e.preventDefault()}>
        <Field name="firstName">
          {({ ref, focusNextField, error, onBlur, onChange, valid, validating, value }) => (
            <>
              <label htmlFor="firstName">First name</label>

              <input
                type="text"
                id="firstName"
                ref={ref}
                value={value}
                onBlur={onBlur}
                onChange={(e) => {
                  e.preventDefault();
                  const { value } = e.target;
                  onChange(value);

                  if (value.length > 3) {
                    focusNextField();
                  }
                }}
              />

              {!(valid || error) && <div>firstName idle</div>}
              {valid && <div>firstName valid</div>}
              {validating && <div>firstName validating</div>}
              {error && <div>firstName error</div>}
            </>
          )}
        </Field>

        <Field name="lastName">
          {({ ref, error, onBlur, onChange, valid, validating, value }) => (
            <>
              <label htmlFor="lastName">Last name</label>

              <input
                type="text"
                id="lastName"
                ref={ref}
                value={value}
                onBlur={onBlur}
                onChange={(e) => {
                  e.preventDefault();
                  onChange(e.target.value);
                }}
              />

              {!(valid || error) && <div>lastName idle</div>}
              {valid && <div>lastName valid</div>}
              {validating && <div>lastName validating</div>}
              {error && <div>lastName error</div>}
            </>
          )}
        </Field>

        <button onClick={(e) => focusField("firstName")}>Focus firstName</button>
      </form>
    );
  };

  const { findByLabelText, findByText } = render(<Test />);

  const firstNameInput = await findByLabelText("First name");
  const lastNameInput = await findByLabelText("Last name");

  const focusFirstNameButton = await findByText("Focus firstName");

  fireEvent.click(focusFirstNameButton);
  expect(firstNameInput).toHaveFocus();

  fireEvent.input(firstNameInput, { target: { value: "Nicolas" } });
  expect(lastNameInput).toHaveFocus();
});
