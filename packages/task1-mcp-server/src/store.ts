/** In-memory stand-in for the customer system of record. */
export interface CustomerRecord {
  customer_id: string;
  name: string;
  email: string;
  balance_cents: number;
  status: "active" | "suspended";
}

export interface Refund {
  refund_id: string;
  customer_id: string;
  amount: number;
  reason: string;
  created_at: string;
}

const customers = new Map<string, CustomerRecord>([
  ["CUST-00001", { customer_id: "CUST-00001", name: "Ada Lovelace", email: "ada@example.com", balance_cents: 12_500, status: "active" }],
  ["CUST-00002", { customer_id: "CUST-00002", name: "Alan Turing", email: "alan@example.com", balance_cents: 0, status: "suspended" }],
  ["CUST-A1B2C", { customer_id: "CUST-A1B2C", name: "Grace Hopper", email: "grace@example.com", balance_cents: 99_999, status: "active" }],
]);

const refunds: Refund[] = [];
let seq = 0;

export const store = {
  getCustomer(id: string): CustomerRecord | undefined {
    return customers.get(id);
  },
  createRefund(customer_id: string, amount: number, reason: string): Refund {
    seq += 1;
    const refund: Refund = {
      refund_id: `RF-${String(seq).padStart(6, "0")}`,
      customer_id,
      amount,
      reason,
      created_at: new Date().toISOString(),
    };
    refunds.push(refund);
    return refund;
  },
  listRefunds(): readonly Refund[] {
    return refunds;
  },
};
