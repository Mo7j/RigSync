import { React, h } from "../lib/react.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Field, TextInput } from "../components/ui/Field.js";
import { TEST_USER } from "../features/auth/auth.js";

const { useState } = React;

export function LoginPage({ isAuthenticated, onLogin, onBackHome }) {
  const [email, setEmail] = useState(TEST_USER.email);
  const [password, setPassword] = useState(TEST_USER.password);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      await onLogin({ email, password });
    } catch (nextError) {
      setError(nextError.message || "Login failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return h(
    "main",
    { className: "auth-shell" },
    h(
      "button",
      {
        type: "button",
        className: "icon-button auth-back-button",
        onClick: onBackHome,
        "aria-label": "Back to Home",
      },
      "<",
    ),
    h(
      Card,
      { className: "auth-card" },
      h("p", { className: "eyebrow" }, "Welcome"),
      h("h1", { className: "auth-title" }, isAuthenticated ? "Session already active" : "Login"),
      h(
        "p",
        { className: "muted-copy" },
        "Sign in to access the dashboard and operational workspace.",
      ),
      h(
        "form",
        { className: "auth-form", onSubmit: handleSubmit },
        h(
          Field,
          { label: "Email" },
          h(TextInput, {
            type: "email",
            value: email,
            placeholder: "name@company.com",
            onChange: (event) => setEmail(event.target.value),
          }),
        ),
        h(
          Field,
          { label: "Password" },
          h(TextInput, {
            type: "password",
            value: password,
            placeholder: "Enter your password",
            onChange: (event) => setPassword(event.target.value),
          }),
        ),
        h(
          "div",
          { className: "auth-meta-row" },
          h(
            "button",
            {
              type: "button",
              className: "auth-text-link",
            },
            "Forgot your password?",
          ),
        ),
        error ? h("p", { className: "field-error auth-error" }, error) : null,
        h(
          "div",
          { className: "auth-actions" },
          h(Button, {
            type: "submit",
            className: "login-primary",
            isBusy: isSubmitting,
            children: "Login",
          }),
        ),
        h(
          "div",
          { className: "auth-footer-row" },
          h("span", { className: "muted-copy" }, "Don't have an account?"),
          h(
            "button",
            {
              type: "button",
              className: "auth-text-link auth-signup-link",
            },
            "Sign up",
          ),
        ),
      ),
    ),
  );
}
