import { BP_TOTAL } from "./money";

export type SplitMode = "equal" | "percentage";

export interface ParticipantInput {
  memberId: string;
  personalMinor: number;
  splitBp?: number;
}

export interface SplitInput {
  totalMinor: number;
  mode: SplitMode;
  participants: ParticipantInput[];
}

export interface MemberShare {
  memberId: string;
  shareMinor: number;
}

export interface SplitResult {
  shares: MemberShare[];
  remainderMinor: number;
}

export function computeShares(input: SplitInput): SplitResult {
  const personalTotal = input.participants.reduce(
    (sum, participant) => sum + participant.personalMinor,
    0,
  );
  const remainderTotal = input.totalMinor - personalTotal;
  const splitMinor =
    input.mode === "equal"
      ? splitEqually(remainderTotal, input.participants.length)
      : splitByBasisPoints(remainderTotal, input.participants);

  const shares = input.participants.map((participant, index) => ({
    memberId: participant.memberId,
    shareMinor: participant.personalMinor + splitMinor[index],
  }));
  const assignedTotal = shares.reduce(
    (sum, share) => sum + share.shareMinor,
    0,
  );

  return { shares, remainderMinor: input.totalMinor - assignedTotal };
}

function splitEqually(remainderTotal: number, count: number): number[] {
  const dividend = BigInt(remainderTotal);
  const divisor = BigInt(count);
  const base = Number(dividend / divisor);
  let leftover = Number(dividend % divisor);
  return Array.from({ length: count }, () => base + (leftover-- > 0 ? 1 : 0));
}

function splitByBasisPoints(
  remainderTotal: number,
  participants: ParticipantInput[],
): number[] {
  const scaled = participants.map((participant) => {
    const value = BigInt(remainderTotal) * BigInt(participant.splitBp ?? 0);
    return {
      floor: Number(value / BigInt(BP_TOTAL)),
      fraction: Number(value % BigInt(BP_TOTAL)),
    };
  });
  const baseShares = scaled.map((share) => share.floor);
  let leftover =
    remainderTotal - baseShares.reduce((sum, share) => sum + share, 0);
  const order = scaled
    .map((_, index) => index)
    .sort((a, b) =>
      scaled[a].fraction === scaled[b].fraction
        ? a - b
        : scaled[b].fraction - scaled[a].fraction,
    );
  for (const index of order) {
    if (leftover <= 0) break;
    baseShares[index] += 1;
    leftover -= 1;
  }
  return baseShares;
}
