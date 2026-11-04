"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button, Card, CardText, CardTitle, Input } from "@/components/ui";
import { authClient } from "@/lib/auth-client";

interface ProfileFormProps {
  initialName: string;
  email: string;
}

interface ErrorBody {
  ok?: boolean;
  error?: string;
  field?: string;
  message?: string;
}

export function ProfileForm({ initialName, email }: ProfileFormProps) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameStatus, setNameStatus] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentPasswordError, setCurrentPasswordError] = useState<
    string | null
  >(null);
  const [newPasswordError, setNewPasswordError] = useState<string | null>(null);
  const [confirmPasswordError, setConfirmPasswordError] = useState<
    string | null
  >(null);
  const [passwordStatus, setPasswordStatus] = useState<string | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);

  const [signingOut, setSigningOut] = useState(false);

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNameError(null);
    setNameStatus(null);
    setSavingName(true);
    try {
      const response = await fetch("/api/account/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = (await response.json()) as ErrorBody;
      if (!response.ok) {
        if (response.status === 401) {
          router.replace("/login");
          return;
        }
        setNameError(nameErrorMessage(data));
        return;
      }
      setNameStatus("Display name updated.");
      router.refresh();
    } catch {
      setNameError("Something went wrong. Please try again.");
    } finally {
      setSavingName(false);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCurrentPasswordError(null);
    setNewPasswordError(null);
    setConfirmPasswordError(null);
    setPasswordStatus(null);
    setGeneralError(null);

    if (newPassword !== confirmPassword) {
      setConfirmPasswordError("Passwords do not match.");
      return;
    }

    setChangingPassword(true);
    try {
      const response = await fetch("/api/account/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = (await response.json()) as ErrorBody;
      if (!response.ok) {
        if (response.status === 401) {
          router.replace("/login");
          return;
        }
        applyPasswordError(data);
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordStatus(
        "Password updated. Your other sessions were signed out.",
      );
    } catch {
      setGeneralError("Something went wrong. Please try again.");
    } finally {
      setChangingPassword(false);
    }
  }

  function applyPasswordError(data: ErrorBody) {
    switch (data.error) {
      case "WRONG_CURRENT_PASSWORD":
        setCurrentPasswordError("Current password is incorrect.");
        return;
      case "CURRENT_PASSWORD_REQUIRED":
        setCurrentPasswordError("Enter your current password.");
        return;
      case "INVALID_NEW_PASSWORD":
        setNewPasswordError("New password must be 8 to 128 characters.");
        return;
      case "NO_PASSWORD_SET":
        setGeneralError("This account has no password yet.");
        return;
      default:
        setGeneralError(
          data.message ?? data.error ?? "Could not update the password.",
        );
    }
  }

  async function signOut() {
    setSigningOut(true);
    setGeneralError(null);
    const result = await authClient.signOut();
    if (result.error) {
      setGeneralError("Could not sign out. Please try again.");
      setSigningOut(false);
      return;
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardTitle>Your details</CardTitle>
        <CardText className="mt-1">
          This is the name your friends see in shared events.
        </CardText>
        <form
          onSubmit={saveName}
          className="mt-5 flex flex-col gap-5"
          noValidate
        >
          <Input
            label="Display name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            maxLength={80}
            error={nameError ?? undefined}
            hint="1 to 80 characters."
          />
          <Input
            label="Email"
            value={email}
            readOnly
            disabled
            hint="Email can't be changed."
          />
          {nameStatus ? (
            <output className="text-sm font-semibold text-success">
              {nameStatus}
            </output>
          ) : null}
          <Button type="submit" loading={savingName}>
            Save changes
          </Button>
        </form>
      </Card>

      <Card>
        <CardTitle>Password</CardTitle>
        <CardText className="mt-1">
          Changing your password signs out your other devices.
        </CardText>
        <form
          onSubmit={changePassword}
          className="mt-5 flex flex-col gap-5"
          noValidate
        >
          <Input
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            error={currentPasswordError ?? undefined}
          />
          <Input
            label="New password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            hint="At least 8 characters."
            error={newPasswordError ?? undefined}
          />
          <Input
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            error={confirmPasswordError ?? undefined}
          />
          {passwordStatus ? (
            <output className="text-sm font-semibold text-success">
              {passwordStatus}
            </output>
          ) : null}
          <Button type="submit" loading={changingPassword}>
            Update password
          </Button>
        </form>
      </Card>

      <Card>
        <CardTitle>Sign out</CardTitle>
        <CardText className="mt-1">
          You'll need your email and password to sign back in.
        </CardText>
        <div className="mt-5">
          <Button
            variant="secondary"
            onClick={signOut}
            loading={signingOut}
            disabled={changingPassword}
          >
            Sign out
          </Button>
        </div>
        {generalError ? (
          <p role="alert" className="mt-3 text-sm font-semibold text-danger">
            {generalError}
          </p>
        ) : null}
      </Card>
    </div>
  );
}

function nameErrorMessage(data: ErrorBody): string {
  switch (data.error) {
    case "NAME_REQUIRED":
      return "Enter a display name.";
    case "NAME_TOO_LONG":
      return "Display name must be 80 characters or fewer.";
    case "INVALID_NAME":
      return "Enter a valid display name.";
    default:
      return data.message ?? data.error ?? "Could not update your name.";
  }
}
