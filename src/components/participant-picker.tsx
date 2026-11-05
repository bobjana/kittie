"use client";

import { Checkbox } from "@/components/ui";

export interface ParticipantOption {
  id: string;
  displayName: string | null;
  emailNormalized: string;
}

export function participantName(option: ParticipantOption): string {
  return option.displayName ?? option.emailNormalized;
}

export interface ParticipantPickerProps {
  members: ParticipantOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

export function ParticipantPicker({
  members,
  selectedIds,
  onChange,
}: ParticipantPickerProps) {
  function toggle(id: string, checked: boolean) {
    onChange(
      checked
        ? members
            .filter(
              (member) => selectedIds.includes(member.id) || member.id === id,
            )
            .map((member) => member.id)
        : selectedIds.filter((memberId) => memberId !== id),
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {members.map((member) => {
        const name = participantName(member);
        return (
          <li key={member.id}>
            <Checkbox
              label={name}
              hint={member.displayName ? member.emailNormalized : undefined}
              checked={selectedIds.includes(member.id)}
              onChange={(event) => toggle(member.id, event.target.checked)}
            />
          </li>
        );
      })}
    </ul>
  );
}
