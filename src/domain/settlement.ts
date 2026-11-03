export interface SettlementExpense {
  paidByMemberId: string;
  totalMinor: number;
  shares: { memberId: string; shareMinor: number }[];
  voided: boolean;
}

export interface BalanceReport {
  totalSpentMinor: number;
  totalOwedMinor: number;
  balances: Map<string, number>;
}

export interface Transfer {
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
}

export class SettlementAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementAssertionError";
  }
}

export function computeBalances(expenses: SettlementExpense[]): BalanceReport {
  const balances = new Map<string, number>();
  let totalSpentMinor = 0;

  for (const expense of expenses) {
    if (expense.voided) continue;
    assertReconciledExpense(expense);
    totalSpentMinor += expense.totalMinor;
    addToBalance(balances, expense.paidByMemberId, -expense.totalMinor);
    for (const share of expense.shares) {
      addToBalance(balances, share.memberId, share.shareMinor);
    }
  }

  let totalOwedMinor = 0;
  for (const balance of balances.values()) {
    if (balance > 0) totalOwedMinor += balance;
  }

  return { totalSpentMinor, totalOwedMinor, balances };
}

export function settle(
  balances: ReadonlyMap<string, number>,
  canonicalOrder: string[],
): Transfer[] {
  const debtors: { memberId: string; amountMinor: number }[] = [];
  const creditors: { memberId: string; amountMinor: number }[] = [];
  let sumMinor = 0;

  for (const [memberId, balance] of balances) {
    sumMinor += balance;
    if (balance > 0) debtors.push({ memberId, amountMinor: balance });
    if (balance < 0) creditors.push({ memberId, amountMinor: -balance });
  }

  if (sumMinor !== 0) {
    throw new SettlementAssertionError(
      `balances must sum to zero, got ${sumMinor}`,
    );
  }

  debtors.sort(byAmountThenCanonicalOrder(canonicalOrder));
  creditors.sort(byAmountThenCanonicalOrder(canonicalOrder));

  const transfers: Transfer[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amountMinor = Math.min(debtor.amountMinor, creditor.amountMinor);
    transfers.push({
      fromMemberId: debtor.memberId,
      toMemberId: creditor.memberId,
      amountMinor,
    });
    debtor.amountMinor -= amountMinor;
    creditor.amountMinor -= amountMinor;
    if (debtor.amountMinor === 0) debtorIndex += 1;
    if (creditor.amountMinor === 0) creditorIndex += 1;
  }

  return transfers;
}

function byAmountThenCanonicalOrder(canonicalOrder: string[]) {
  const rank = (memberId: string): number => {
    const index = canonicalOrder.indexOf(memberId);
    return index === -1 ? canonicalOrder.length : index;
  };
  return (
    a: { memberId: string; amountMinor: number },
    b: { memberId: string; amountMinor: number },
  ): number =>
    b.amountMinor - a.amountMinor || rank(a.memberId) - rank(b.memberId);
}

function assertReconciledExpense(expense: SettlementExpense): void {
  if (!Number.isInteger(expense.totalMinor) || expense.totalMinor <= 0) {
    throw new SettlementAssertionError(
      `expense total must be a positive integer, got ${expense.totalMinor}`,
    );
  }

  let sharesTotal = 0;
  for (const share of expense.shares) {
    if (!Number.isInteger(share.shareMinor) || share.shareMinor < 0) {
      throw new SettlementAssertionError(
        `share for ${share.memberId} must be a non-negative integer, got ${share.shareMinor}`,
      );
    }
    sharesTotal += share.shareMinor;
  }

  if (sharesTotal !== expense.totalMinor) {
    throw new SettlementAssertionError(
      `shares sum to ${sharesTotal}, expected ${expense.totalMinor}`,
    );
  }
}

function addToBalance(
  balances: Map<string, number>,
  memberId: string,
  delta: number,
): void {
  balances.set(memberId, (balances.get(memberId) ?? 0) + delta);
}
