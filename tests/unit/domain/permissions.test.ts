/**
 * Table-driven permission matrix (plan row 6).
 *
 * Six actor roles x three subject states, asserted directly against the
 * server-side predicates in src/domain/permissions.ts - no UI is involved.
 *
 * Conventions:
 * - Subject state "open"/"closed" comes from the event; "voided" comes from
 *   the expense and dominates: a voided expense is read-only for everyone.
 *   Event-scoped actions (invite, remove member, close, reopen) are checked
 *   by their callers against the event state, so those routes pass
 *   "open"/"closed"; the voided rows here document subject-scoped behavior.
 * - The capturer is "capt", the organizer is "org". Participants of the
 *   expense under test: org (0), capt (2000), part (1000), zero (0).
 *   Total is 10000 minor units.
 * - Row 13 brief: void is capturer OR organizer while the subject is open,
 *   so the matrix rows below reflect that (row 6's organizer-only cut was
 *   refined when void shipped).
 */
import { describe, expect, it } from "vitest";
import {
  type Actor,
  canCloseEvent,
  canEditField,
  canEditPersonal,
  canInviteMember,
  canRead,
  canRemoveEventMember,
  canRemoveParticipant,
  canReopenEvent,
  canVoidExpense,
  EXPENSE_FIELDS,
  type ExpenseSubject,
  isPersonalWithinBound,
  type MemberTarget,
  PERMISSION_CODES,
  PERMISSION_HTTP_STATUS,
  type PermissionResult,
  type SubjectState,
} from "../../../src/domain/permissions";

const C = PERMISSION_CODES;

const actors = {
  organizer: (): Actor => ({ memberId: "org", kind: "organizer" }),
  capturer: (): Actor => ({ memberId: "capt", kind: "active-member" }),
  participant: (): Actor => ({ memberId: "part", kind: "active-member" }),
  other: (): Actor => ({ memberId: "other", kind: "active-member" }),
  pending: (): Actor => ({ memberId: "pend", kind: "pending-member" }),
  nonMember: (): Actor => ({ memberId: "ghost", kind: "non-member" }),
  removed: (): Actor => ({ memberId: "gone", kind: "removed-member" }),
};

const subject = (state: SubjectState): ExpenseSubject => ({
  state,
  capturerMemberId: "capt",
});

const personalContext = {
  totalMinor: 10000,
  participants: [
    { memberId: "org", personalMinor: 0 },
    { memberId: "capt", personalMinor: 2000 },
    { memberId: "part", personalMinor: 1000 },
    { memberId: "zero", personalMinor: 0 },
  ],
};

const removableTarget: MemberTarget = { role: "member", status: "active" };

type Expect = "allow" | `deny:${string}`;

interface MatrixRow {
  name: string;
  actor: Actor;
  state: SubjectState;
  read: Expect;
  editTotal: Expect;
  ownPersonal: Expect;
  otherPersonal: Expect;
  invite: Expect;
  removeMember: Expect;
  close: Expect;
  reopen: Expect;
  voidExpense: Expect;
  removeParticipant: Expect;
}

const d = (code: string): Expect => `deny:${code}`;

const matrixRows: MatrixRow[] = [
  {
    name: "organizer in open",
    actor: actors.organizer(),
    state: "open",
    read: "allow",
    editTotal: d(C.NOT_CAPTURER),
    ownPersonal: "allow",
    otherPersonal: d(C.NOT_OWN_PERSONAL),
    invite: "allow",
    removeMember: "allow",
    close: "allow",
    reopen: d(C.EVENT_NOT_CLOSED),
    voidExpense: "allow",
    removeParticipant: d(C.NOT_CAPTURER),
  },
  {
    name: "capturer in open",
    actor: actors.capturer(),
    state: "open",
    read: "allow",
    editTotal: "allow",
    ownPersonal: "allow",
    otherPersonal: d(C.NOT_OWN_PERSONAL),
    invite: d(C.NOT_ORGANIZER),
    removeMember: d(C.NOT_ORGANIZER),
    close: d(C.NOT_ORGANIZER),
    reopen: d(C.EVENT_NOT_CLOSED),
    voidExpense: "allow",
    removeParticipant: "allow",
  },
  {
    name: "participant in open",
    actor: actors.participant(),
    state: "open",
    read: "allow",
    editTotal: d(C.NOT_CAPTURER),
    ownPersonal: "allow",
    otherPersonal: d(C.NOT_OWN_PERSONAL),
    invite: d(C.NOT_ORGANIZER),
    removeMember: d(C.NOT_ORGANIZER),
    close: d(C.NOT_ORGANIZER),
    reopen: d(C.EVENT_NOT_CLOSED),
    voidExpense: d(C.NOT_ORGANIZER),
    removeParticipant: d(C.NOT_CAPTURER),
  },
  {
    name: "other member in open",
    actor: actors.other(),
    state: "open",
    read: "allow",
    editTotal: d(C.NOT_CAPTURER),
    ownPersonal: d(C.NOT_A_PARTICIPANT),
    otherPersonal: d(C.NOT_OWN_PERSONAL),
    invite: d(C.NOT_ORGANIZER),
    removeMember: d(C.NOT_ORGANIZER),
    close: d(C.NOT_ORGANIZER),
    reopen: d(C.EVENT_NOT_CLOSED),
    voidExpense: d(C.NOT_ORGANIZER),
    removeParticipant: d(C.NOT_CAPTURER),
  },
  {
    name: "pending member in open",
    actor: actors.pending(),
    state: "open",
    read: d(C.PENDING_MEMBER),
    editTotal: d(C.PENDING_MEMBER),
    ownPersonal: d(C.PENDING_MEMBER),
    otherPersonal: d(C.PENDING_MEMBER),
    invite: d(C.PENDING_MEMBER),
    removeMember: d(C.PENDING_MEMBER),
    close: d(C.PENDING_MEMBER),
    reopen: d(C.PENDING_MEMBER),
    voidExpense: d(C.PENDING_MEMBER),
    removeParticipant: d(C.PENDING_MEMBER),
  },
  {
    name: "non-member in open",
    actor: actors.nonMember(),
    state: "open",
    read: d(C.NOT_A_MEMBER),
    editTotal: d(C.NOT_A_MEMBER),
    ownPersonal: d(C.NOT_A_MEMBER),
    otherPersonal: d(C.NOT_A_MEMBER),
    invite: d(C.NOT_A_MEMBER),
    removeMember: d(C.NOT_A_MEMBER),
    close: d(C.NOT_A_MEMBER),
    reopen: d(C.NOT_A_MEMBER),
    voidExpense: d(C.NOT_A_MEMBER),
    removeParticipant: d(C.NOT_A_MEMBER),
  },
  {
    name: "removed member in open",
    actor: actors.removed(),
    state: "open",
    read: d(C.MEMBER_REMOVED),
    editTotal: d(C.MEMBER_REMOVED),
    ownPersonal: d(C.MEMBER_REMOVED),
    otherPersonal: d(C.MEMBER_REMOVED),
    invite: d(C.MEMBER_REMOVED),
    removeMember: d(C.MEMBER_REMOVED),
    close: d(C.MEMBER_REMOVED),
    reopen: d(C.MEMBER_REMOVED),
    voidExpense: d(C.MEMBER_REMOVED),
    removeParticipant: d(C.MEMBER_REMOVED),
  },
  {
    name: "organizer in closed",
    actor: actors.organizer(),
    state: "closed",
    read: "allow",
    editTotal: d(C.EVENT_CLOSED),
    ownPersonal: d(C.EVENT_CLOSED),
    otherPersonal: d(C.EVENT_CLOSED),
    invite: d(C.EVENT_CLOSED),
    removeMember: d(C.EVENT_CLOSED),
    close: d(C.EVENT_CLOSED),
    reopen: "allow",
    voidExpense: d(C.EVENT_CLOSED),
    removeParticipant: d(C.EVENT_CLOSED),
  },
  {
    name: "capturer in closed",
    actor: actors.capturer(),
    state: "closed",
    read: "allow",
    editTotal: d(C.EVENT_CLOSED),
    ownPersonal: d(C.EVENT_CLOSED),
    otherPersonal: d(C.EVENT_CLOSED),
    invite: d(C.EVENT_CLOSED),
    removeMember: d(C.EVENT_CLOSED),
    close: d(C.EVENT_CLOSED),
    reopen: d(C.NOT_ORGANIZER),
    voidExpense: d(C.EVENT_CLOSED),
    removeParticipant: d(C.EVENT_CLOSED),
  },
  {
    name: "participant in closed",
    actor: actors.participant(),
    state: "closed",
    read: "allow",
    editTotal: d(C.EVENT_CLOSED),
    ownPersonal: d(C.EVENT_CLOSED),
    otherPersonal: d(C.EVENT_CLOSED),
    invite: d(C.EVENT_CLOSED),
    removeMember: d(C.EVENT_CLOSED),
    close: d(C.EVENT_CLOSED),
    reopen: d(C.NOT_ORGANIZER),
    voidExpense: d(C.EVENT_CLOSED),
    removeParticipant: d(C.EVENT_CLOSED),
  },
  {
    name: "other member in closed",
    actor: actors.other(),
    state: "closed",
    read: "allow",
    editTotal: d(C.EVENT_CLOSED),
    ownPersonal: d(C.EVENT_CLOSED),
    otherPersonal: d(C.EVENT_CLOSED),
    invite: d(C.EVENT_CLOSED),
    removeMember: d(C.EVENT_CLOSED),
    close: d(C.EVENT_CLOSED),
    reopen: d(C.NOT_ORGANIZER),
    voidExpense: d(C.EVENT_CLOSED),
    removeParticipant: d(C.EVENT_CLOSED),
  },
  {
    name: "pending member in closed",
    actor: actors.pending(),
    state: "closed",
    read: d(C.PENDING_MEMBER),
    editTotal: d(C.PENDING_MEMBER),
    ownPersonal: d(C.PENDING_MEMBER),
    otherPersonal: d(C.PENDING_MEMBER),
    invite: d(C.PENDING_MEMBER),
    removeMember: d(C.PENDING_MEMBER),
    close: d(C.PENDING_MEMBER),
    reopen: d(C.PENDING_MEMBER),
    voidExpense: d(C.PENDING_MEMBER),
    removeParticipant: d(C.PENDING_MEMBER),
  },
  {
    name: "non-member in closed",
    actor: actors.nonMember(),
    state: "closed",
    read: d(C.NOT_A_MEMBER),
    editTotal: d(C.NOT_A_MEMBER),
    ownPersonal: d(C.NOT_A_MEMBER),
    otherPersonal: d(C.NOT_A_MEMBER),
    invite: d(C.NOT_A_MEMBER),
    removeMember: d(C.NOT_A_MEMBER),
    close: d(C.NOT_A_MEMBER),
    reopen: d(C.NOT_A_MEMBER),
    voidExpense: d(C.NOT_A_MEMBER),
    removeParticipant: d(C.NOT_A_MEMBER),
  },
  {
    name: "removed member in closed",
    actor: actors.removed(),
    state: "closed",
    read: d(C.MEMBER_REMOVED),
    editTotal: d(C.MEMBER_REMOVED),
    ownPersonal: d(C.MEMBER_REMOVED),
    otherPersonal: d(C.MEMBER_REMOVED),
    invite: d(C.MEMBER_REMOVED),
    removeMember: d(C.MEMBER_REMOVED),
    close: d(C.MEMBER_REMOVED),
    reopen: d(C.MEMBER_REMOVED),
    voidExpense: d(C.MEMBER_REMOVED),
    removeParticipant: d(C.MEMBER_REMOVED),
  },
  {
    name: "organizer in voided",
    actor: actors.organizer(),
    state: "voided",
    read: "allow",
    editTotal: d(C.EXPENSE_VOIDED),
    ownPersonal: d(C.EXPENSE_VOIDED),
    otherPersonal: d(C.EXPENSE_VOIDED),
    invite: d(C.EXPENSE_VOIDED),
    removeMember: d(C.EXPENSE_VOIDED),
    close: d(C.EXPENSE_VOIDED),
    reopen: d(C.EXPENSE_VOIDED),
    voidExpense: d(C.EXPENSE_VOIDED),
    removeParticipant: d(C.EXPENSE_VOIDED),
  },
  {
    name: "capturer in voided",
    actor: actors.capturer(),
    state: "voided",
    read: "allow",
    editTotal: d(C.EXPENSE_VOIDED),
    ownPersonal: d(C.EXPENSE_VOIDED),
    otherPersonal: d(C.EXPENSE_VOIDED),
    invite: d(C.EXPENSE_VOIDED),
    removeMember: d(C.EXPENSE_VOIDED),
    close: d(C.EXPENSE_VOIDED),
    reopen: d(C.EXPENSE_VOIDED),
    voidExpense: d(C.EXPENSE_VOIDED),
    removeParticipant: d(C.EXPENSE_VOIDED),
  },
  {
    name: "participant in voided",
    actor: actors.participant(),
    state: "voided",
    read: "allow",
    editTotal: d(C.EXPENSE_VOIDED),
    ownPersonal: d(C.EXPENSE_VOIDED),
    otherPersonal: d(C.EXPENSE_VOIDED),
    invite: d(C.EXPENSE_VOIDED),
    removeMember: d(C.EXPENSE_VOIDED),
    close: d(C.EXPENSE_VOIDED),
    reopen: d(C.EXPENSE_VOIDED),
    voidExpense: d(C.EXPENSE_VOIDED),
    removeParticipant: d(C.EXPENSE_VOIDED),
  },
  {
    name: "other member in voided",
    actor: actors.other(),
    state: "voided",
    read: "allow",
    editTotal: d(C.EXPENSE_VOIDED),
    ownPersonal: d(C.EXPENSE_VOIDED),
    otherPersonal: d(C.EXPENSE_VOIDED),
    invite: d(C.EXPENSE_VOIDED),
    removeMember: d(C.EXPENSE_VOIDED),
    close: d(C.EXPENSE_VOIDED),
    reopen: d(C.EXPENSE_VOIDED),
    voidExpense: d(C.EXPENSE_VOIDED),
    removeParticipant: d(C.EXPENSE_VOIDED),
  },
  {
    name: "pending member in voided",
    actor: actors.pending(),
    state: "voided",
    read: d(C.PENDING_MEMBER),
    editTotal: d(C.PENDING_MEMBER),
    ownPersonal: d(C.PENDING_MEMBER),
    otherPersonal: d(C.PENDING_MEMBER),
    invite: d(C.PENDING_MEMBER),
    removeMember: d(C.PENDING_MEMBER),
    close: d(C.PENDING_MEMBER),
    reopen: d(C.PENDING_MEMBER),
    voidExpense: d(C.PENDING_MEMBER),
    removeParticipant: d(C.PENDING_MEMBER),
  },
  {
    name: "non-member in voided",
    actor: actors.nonMember(),
    state: "voided",
    read: d(C.NOT_A_MEMBER),
    editTotal: d(C.NOT_A_MEMBER),
    ownPersonal: d(C.NOT_A_MEMBER),
    otherPersonal: d(C.NOT_A_MEMBER),
    invite: d(C.NOT_A_MEMBER),
    removeMember: d(C.NOT_A_MEMBER),
    close: d(C.NOT_A_MEMBER),
    reopen: d(C.NOT_A_MEMBER),
    voidExpense: d(C.NOT_A_MEMBER),
    removeParticipant: d(C.NOT_A_MEMBER),
  },
  {
    name: "removed member in voided",
    actor: actors.removed(),
    state: "voided",
    read: d(C.MEMBER_REMOVED),
    editTotal: d(C.MEMBER_REMOVED),
    ownPersonal: d(C.MEMBER_REMOVED),
    otherPersonal: d(C.MEMBER_REMOVED),
    invite: d(C.MEMBER_REMOVED),
    removeMember: d(C.MEMBER_REMOVED),
    close: d(C.MEMBER_REMOVED),
    reopen: d(C.MEMBER_REMOVED),
    voidExpense: d(C.MEMBER_REMOVED),
    removeParticipant: d(C.MEMBER_REMOVED),
  },
];

function expectVerdict(actual: PermissionResult, expected: Expect) {
  if (expected === "allow") {
    expect(actual).toEqual({ ok: true });
    return;
  }
  expect(actual).toEqual({
    ok: false,
    code: expected.slice("deny:".length),
    message: expect.any(String),
  });
}

describe("permission matrix (role x state)", () => {
  it.each(matrixRows)("$name", (row) => {
    const subj = subject(row.state);
    expectVerdict(canRead(row.actor, subj), row.read);
    expectVerdict(canEditField(row.actor, subj, "totalMinor"), row.editTotal);
    expectVerdict(
      canEditPersonal(
        row.actor,
        subj,
        row.actor.memberId,
        5000,
        personalContext,
      ),
      row.ownPersonal,
    );
    expectVerdict(
      canEditPersonal(row.actor, subj, "zero", 5000, personalContext),
      row.otherPersonal,
    );
    expectVerdict(canInviteMember(row.actor, subj), row.invite);
    expectVerdict(
      canRemoveEventMember(row.actor, subj, removableTarget),
      row.removeMember,
    );
    expectVerdict(canCloseEvent(row.actor, subj), row.close);
    expectVerdict(canReopenEvent(row.actor, subj), row.reopen);
    expectVerdict(canVoidExpense(row.actor, subj), row.voidExpense);
    expectVerdict(
      canRemoveParticipant(row.actor, subj, "zero", 0),
      row.removeParticipant,
    );
  });
});

describe("capturer-only expense fields", () => {
  const open = subject("open");

  it.each([...EXPENSE_FIELDS])("capturer may edit %s while open", (field) => {
    expect(canEditField(actors.capturer(), open, field)).toEqual({ ok: true });
  });

  it.each([
    ...EXPENSE_FIELDS,
  ])("other members may not edit %s while open", (field) => {
    expect(canEditField(actors.participant(), open, field)).toEqual({
      ok: false,
      code: C.NOT_CAPTURER,
      message: expect.any(String),
    });
  });
});

describe("personal amount bound", () => {
  const boundContext = {
    totalMinor: 10000,
    participants: [
      { memberId: "capt", personalMinor: 2000 },
      { memberId: "part", personalMinor: 1000 },
    ],
  };

  it.each([
    {
      label: "negative amount",
      memberId: "capt",
      proposed: -1,
      expected: false,
    },
    { label: "zero amount", memberId: "capt", proposed: 0, expected: true },
    {
      label: "total minus others",
      memberId: "capt",
      proposed: 9000,
      expected: true,
    },
    {
      label: "one over the bound",
      memberId: "capt",
      proposed: 9001,
      expected: false,
    },
    {
      label: "full total with others owing",
      memberId: "capt",
      proposed: 10000,
      expected: false,
    },
    {
      label: "new participant starts at 0",
      memberId: "other",
      proposed: 0,
      expected: true,
    },
    {
      label: "negative for non-participant",
      memberId: "other",
      proposed: -1,
      expected: false,
    },
  ])("$label: isPersonalWithinBound($memberId, $proposed) -> $expected", ({
    memberId,
    proposed,
    expected,
  }) => {
    expect(
      isPersonalWithinBound(
        boundContext.totalMinor,
        boundContext.participants,
        memberId,
        proposed,
      ),
    ).toBe(expected);
  });

  it("allows a personal amount exactly at the bound", () => {
    expect(
      canEditPersonal(
        actors.participant(),
        subject("open"),
        "part",
        8000,
        personalContext,
      ),
    ).toEqual({ ok: true });
  });

  it("denies a personal amount over the bound", () => {
    expect(
      canEditPersonal(
        actors.participant(),
        subject("open"),
        "part",
        8001,
        personalContext,
      ),
    ).toEqual({
      ok: false,
      code: C.PERSONAL_OUT_OF_BOUNDS,
      message: expect.any(String),
    });
  });

  it("denies a negative personal amount", () => {
    expect(
      canEditPersonal(
        actors.participant(),
        subject("open"),
        "part",
        -1,
        personalContext,
      ),
    ).toEqual({
      ok: false,
      code: C.PERSONAL_OUT_OF_BOUNDS,
      message: expect.any(String),
    });
  });

  it("denies a personal edit for a member without a participant row", () => {
    expect(
      canEditPersonal(
        actors.other(),
        subject("open"),
        "other",
        0,
        personalContext,
      ),
    ).toEqual({
      ok: false,
      code: C.NOT_A_PARTICIPANT,
      message: expect.any(String),
    });
  });

  it("denies a personal edit from a non-member", () => {
    expect(
      canEditPersonal(
        actors.nonMember(),
        subject("open"),
        "ghost",
        0,
        personalContext,
      ),
    ).toEqual({
      ok: false,
      code: C.NOT_A_MEMBER,
      message: expect.any(String),
    });
  });
});

describe("capturer removes a participant", () => {
  it("allows removal when the participant's personal amount is 0", () => {
    expect(
      canRemoveParticipant(actors.capturer(), subject("open"), "zero", 0),
    ).toEqual({
      ok: true,
    });
  });

  it("denies removal when the participant's personal amount is > 0", () => {
    expect(
      canRemoveParticipant(actors.capturer(), subject("open"), "part", 1000),
    ).toEqual({
      ok: false,
      code: C.PARTICIPANT_HAS_PERSONAL,
      message: expect.any(String),
    });
  });

  it("denies removal of a non-participant", () => {
    expect(
      canRemoveParticipant(
        actors.capturer(),
        subject("open"),
        "ghost",
        undefined,
      ),
    ).toEqual({
      ok: false,
      code: C.NOT_A_PARTICIPANT,
      message: expect.any(String),
    });
  });
});

describe("organizer removes event members", () => {
  const open = subject("open");

  it("may remove an active member", () => {
    expect(
      canRemoveEventMember(actors.organizer(), open, {
        role: "member",
        status: "active",
      }),
    ).toEqual({ ok: true });
  });

  it("may remove a pending member", () => {
    expect(
      canRemoveEventMember(actors.organizer(), open, {
        role: "member",
        status: "pending",
      }),
    ).toEqual({ ok: true });
  });

  it("may not remove the organizer", () => {
    expect(
      canRemoveEventMember(actors.organizer(), open, {
        role: "organizer",
        status: "active",
      }),
    ).toEqual({
      ok: false,
      code: C.ORGANIZER_NOT_REMOVABLE,
      message: expect.any(String),
    });
  });

  it("may not remove an already-removed member", () => {
    expect(
      canRemoveEventMember(actors.organizer(), open, {
        role: "member",
        status: "removed",
      }),
    ).toEqual({
      ok: false,
      code: C.ALREADY_REMOVED,
      message: expect.any(String),
    });
  });

  it("may not remove someone who is not a member", () => {
    expect(canRemoveEventMember(actors.organizer(), open, undefined)).toEqual({
      ok: false,
      code: C.NOT_A_MEMBER,
      message: expect.any(String),
    });
  });
});

describe("QA failure scenarios (plan row 6)", () => {
  it("another member changing the total is denied, 403-equivalent", () => {
    const result = canEditField(
      actors.participant(),
      subject("open"),
      "totalMinor",
    );
    expect(result).toEqual({
      ok: false,
      code: C.NOT_CAPTURER,
      message: expect.any(String),
    });
    expect(PERMISSION_HTTP_STATUS[C.NOT_CAPTURER]).toBe(403);
  });

  it("a closed event accepts no edit, 409-equivalent", () => {
    const result = canEditField(
      actors.capturer(),
      subject("closed"),
      "totalMinor",
    );
    expect(result).toEqual({
      ok: false,
      code: C.EVENT_CLOSED,
      message: expect.any(String),
    });
    expect(PERMISSION_HTTP_STATUS[C.EVENT_CLOSED]).toBe(409);
  });

  it("a non-member reading the event is denied, 404-equivalent", () => {
    const result = canRead(actors.nonMember(), subject("open"));
    expect(result).toEqual({
      ok: false,
      code: C.NOT_A_MEMBER,
      message: expect.any(String),
    });
    expect(PERMISSION_HTTP_STATUS[C.NOT_A_MEMBER]).toBe(404);
  });

  it("a capturer removing a participant with a personal amount is denied, 409-equivalent", () => {
    const result = canRemoveParticipant(
      actors.capturer(),
      subject("open"),
      "part",
      1000,
    );
    expect(result).toEqual({
      ok: false,
      code: C.PARTICIPANT_HAS_PERSONAL,
      message: expect.any(String),
    });
    expect(PERMISSION_HTTP_STATUS[C.PARTICIPANT_HAS_PERSONAL]).toBe(409);
  });
});

describe("http status mapping", () => {
  it("maps every denial code to a 4xx status", () => {
    for (const code of Object.values(C)) {
      const status = PERMISSION_HTTP_STATUS[code];
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    }
  });

  it("pins the statuses used by route handlers", () => {
    expect(PERMISSION_HTTP_STATUS[C.NOT_A_MEMBER]).toBe(404);
    expect(PERMISSION_HTTP_STATUS[C.PENDING_MEMBER]).toBe(403);
    expect(PERMISSION_HTTP_STATUS[C.MEMBER_REMOVED]).toBe(403);
    expect(PERMISSION_HTTP_STATUS[C.NOT_ORGANIZER]).toBe(403);
    expect(PERMISSION_HTTP_STATUS[C.NOT_CAPTURER]).toBe(403);
    expect(PERMISSION_HTTP_STATUS[C.NOT_OWN_PERSONAL]).toBe(403);
    expect(PERMISSION_HTTP_STATUS[C.NOT_A_PARTICIPANT]).toBe(409);
    expect(PERMISSION_HTTP_STATUS[C.PERSONAL_OUT_OF_BOUNDS]).toBe(422);
    expect(PERMISSION_HTTP_STATUS[C.PARTICIPANT_HAS_PERSONAL]).toBe(409);
    expect(PERMISSION_HTTP_STATUS[C.EVENT_CLOSED]).toBe(409);
    expect(PERMISSION_HTTP_STATUS[C.EXPENSE_VOIDED]).toBe(409);
    expect(PERMISSION_HTTP_STATUS[C.EVENT_NOT_CLOSED]).toBe(409);
    expect(PERMISSION_HTTP_STATUS[C.ORGANIZER_NOT_REMOVABLE]).toBe(403);
    expect(PERMISSION_HTTP_STATUS[C.ALREADY_REMOVED]).toBe(409);
  });
});
