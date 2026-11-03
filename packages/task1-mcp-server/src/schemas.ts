import { z } from "zod";

/** CUST- followed by exactly five uppercase alphanumerics, e.g. CUST-A1B2C. */
export const CUSTOMER_ID_RE = /^CUST-[A-Z0-9]{5}$/;

export const customerIdSchema = z
  .string()
  .regex(CUSTOMER_ID_RE, "customer_id must match CUST-XXXXX (five uppercase letters/digits)");

export const getCustomerRecordInput = {
  customer_id: customerIdSchema,
};

export const triggerRefundInput = {
  customer_id: customerIdSchema,
  amount: z
    .number()
    .finite("amount must be a finite number")
    .positive("amount must be greater than 0"),
  reason: z.string().trim().min(10, "reason must be at least 10 characters"),
};

export const getCustomerRecordSchema = z.object(getCustomerRecordInput).strict();
export const triggerRefundSchema = z.object(triggerRefundInput).strict();

export type GetCustomerRecordArgs = z.infer<typeof getCustomerRecordSchema>;
export type TriggerRefundArgs = z.infer<typeof triggerRefundSchema>;
