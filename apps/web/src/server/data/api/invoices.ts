import 'server-only';
import type { InvoiceDetail } from '@pactagent/core/platform-types';
import type { CustomerData, ListFilter, ManualReminder, MerchantData, SignRequest } from '../types';
import type { ApiKit } from './source';

const usdt = (decimal: string) => `${Number(decimal).toFixed(2)} USDT`;

/** Invoices in live mode: the merchant's list, reminders and sending; the customer's view and acknowledgement. */
export function createApiInvoices({ api, mApi, mPost, post, hold, take }: ApiKit) {
  const path = (id: string) => `/v1/invoices/${encodeURIComponent(id)}`;
  const merchant: Pick<
    MerchantData,
    | 'invoices'
    | 'invoice'
    | 'createInvoice'
    | 'sendInvoice'
    | 'remindInvoice'
    | 'sendReminder'
    | 'manualReminders'
    | 'cancelReminder'
  > = {
    async invoices(filter?: ListFilter) {
      const { data } = await mApi<{ data: InvoiceDetail[] }>('/v1/invoices?expand=detail');
      const query = filter?.query?.trim().toLowerCase();
      return data.filter(
        i =>
          (!filter?.status || filter.status === 'all' || i.status === filter.status) &&
          (!query ||
            `${i.id} ${i.number} ${i.customerEmail} ${i.customerName ?? ''} ${i.memo}`
              .toLowerCase()
              .includes(query)),
      );
    },
    invoice: id => mApi<InvoiceDetail>(`${path(id)}?expand=detail`),
    createInvoice: input => mPost<InvoiceDetail>('/v1/invoices?expand=detail', input),
    async sendInvoice(id) {
      await mPost(`${path(id)}/send`, {});
      return merchant.invoice(id);
    },
    remindInvoice: id => mPost<InvoiceDetail>(`${path(id)}/remind`, {}),
    sendReminder: (id, input) =>
      mPost<ManualReminder>(`${path(id)}/reminders`, { message: input.message, sendAt: input.sendAt }),
    manualReminders: async id => (await mApi<{ data: ManualReminder[] }>(`${path(id)}/reminders`)).data,
    cancelReminder: (id, reminderId) =>
      mPost<ManualReminder>(`${path(id)}/reminders/${encodeURIComponent(reminderId)}/cancel`, {}),
  };
  const mine = (id: string) => `/v1/commerce/me/invoices/${encodeURIComponent(id)}`;
  const customer: Pick<CustomerData, 'invoices' | 'invoice' | 'prepareAcknowledge' | 'submitAcknowledge'> = {
    invoices: async () => (await api<{ data: InvoiceDetail[] }>('/v1/commerce/me/invoices')).data,
    invoice: id => api<InvoiceDetail>(mine(id)),
    async prepareAcknowledge(id): Promise<SignRequest> {
      const [invoice, typedData] = await Promise.all([
        customer.invoice(id),
        api<Record<string, unknown>>(`${mine(id)}/acknowledgement`),
      ]);
      return hold(
        'acknowledge',
        { id },
        {
          title: `Acknowledge ${invoice.number}`,
          lines: [
            { label: 'From', value: invoice.merchantName },
            { label: 'Amount', value: usdt(invoice.amount) },
            {
              label: 'Due',
              value: invoice.dueAt ? new Date(invoice.dueAt).toUTCString().slice(5, 16) : 'On receipt',
            },
          ],
          typedData,
        },
      );
    },
    async submitAcknowledge(token, signature) {
      const { id } = (await take('acknowledge', token)) as { id: string };
      return post<InvoiceDetail>(`${mine(id)}/acknowledge`, { signature });
    },
  };
  return { merchant, customer };
}
