import { React, h } from "../lib/react.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
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
      Card,
      { className: "auth-card" },
      h("p", { className: "eyebrow" }, "RigSync Access"),
      h("h1", { className: "auth-title" }, isAuthenticated ? "Session already active" : "Secure entry for rig move control"),
      h(
        "p",
        { className: "muted-copy" },
        "Use the provided test account to access the dashboard and simulation workspace.",
      ),
      h(
        "form",
        { className: "auth-form", onSubmit: handleSubmit },
        h(
          Field,
          { label: "Email", hint: "Test account: test@a.com" },
          h(TextInput, {
            type: "email",
            value: email,
            placeholder: "test@a.com",
            onChange: (event) => setEmail(event.target.value),
          }),
        ),
        h(
          Field,
          { label: "Password", hint: "Test password: 123123" },
          h(TextInput, {
            type: "password",
            value: password,
            placeholder: "123123",
            onChange: (event) => setPassword(event.target.value),
          }),
        ),
        error ? h("p", { className: "field-error auth-error" }, error) : null,
        h(
          "div",
          { className: "auth-actions" },
          h(Button, {
            type: "submit",
            isBusy: isSubmitting,
            children: "Login",
          }),
          h(Button, {
            type: "button",
            variant: "ghost",
            onClick: onBackHome,
            children: "Back to Home",
          }),
        ),
      ),
      h(
        "div",
        { className: "auth-stats" },
        h(StatCard, { label: "Environment", value: "Prototype", meta: "Validated flow", tone: "green" }),
        h(StatCard, { label: "Auth", value: "Hardcoded", meta: "Scoped for demo", tone: "default" }),
      ),
    ),
  );
}
