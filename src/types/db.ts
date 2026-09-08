/** Roles are an enum in the database; adding one is a migration by design. */
export type UserRole =
  | 'sales_exec'
  | 'sales_manager'
  | 'doctor'
  | 'ops'
  | 'coo'
  | 'ceo'
  | 'admin'
  | 'auditor';

export type PaymentState = 'unpaid' | 'paid' | 'partial' | 'refunded' | 'failed';

export type OrderStage =
  | 'pending_confirm' | 'confirmed' | 'dispatched'
  | 'delivered' | 'rto' | 'cancelled';

export type ConsultationState = 'pending' | 'done' | 'cancelled';

export type SegmentCode = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';

export interface AppUser {
  id: string;
  full_name: string;
  role: UserRole;
  manager_id: string | null;
  is_active: boolean;
}

/** Where each role lands after signing in. */
export const HOME_FOR_ROLE: Record<UserRole, string> = {
  sales_exec: '/today',
  sales_manager: '/today',
  doctor: '/consultation',
  ops: '/orders',
  coo: '/orders',
  ceo: '/orders',
  admin: '/today',
  auditor: '/orders',
};
