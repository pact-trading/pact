import type { Metadata } from 'next';
import { IconShieldCheck } from '@tabler/icons-react';
import { ApprovalButton } from '@/components/compliance/approval-button';
import { NotOfficer } from '@/components/compliance/not-officer';
import { CancelOrders } from '@/components/investor/cancel-orders';
import { DataError } from '@/server/data/errors';
import { FinancingDemoOnly } from '@/components/merchant/financing/demo-only';
import { percent } from '@/components/merchant/financing/financing-parts';
import { Badge, type Tone } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Stat, StatGrid } from '@/components/ui/stat';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { Timeline } from '@/components/ui/timeline';
import { date, dateTime, usd } from '@/lib/format';
import { getData } from '@/server/data';
import type { InvestorApproval } from '@/server/data/parts/financing';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Investor registry' };

const statusTone: Record<InvestorApproval['status'], Tone> = {
  approved: 'success',
  pending: 'warning',
  revoked: 'danger',
  expired: 'danger',
};
const statusLabel: Record<InvestorApproval['status'], string> = {
  approved: 'Approved',
  pending: 'Pending',
  revoked: 'Revoked',
  expired: 'Expired',
};

export default async function CompliancePage() {
  let registry;
  try {
    registry = await load(async () => (await getData()).financing.registry());
  } catch (error) {
    // Live mode: a signed-in wallet the registry does not list as an officer.
    if (error instanceof DataError && error.code === 'not_compliance_officer') return <NotOfficer />;
    throw error;
  }
  if (isNotWired(registry)) return <FinancingDemoOnly feature={registry.feature} path="/compliance" />;
  const { investors, refusals, assumptions } = registry;
  const approved = investors.filter(i => i.approval.status === 'approved');
  const held = investors.reduce((sum, i) => sum + BigInt(i.heldMinor), 0n);
  const rules = [
    [
      'Only approved investors can buy, send or receive the token',
      'Investor eligibility. Anything else reverts.',
    ],
    [
      'Compliance can revoke an investor at any time',
      'Sanctions or a lapsed review. Repayments on what it holds still arrive.',
    ],
    [
      `No transfers in the ${assumptions.recordDateHours} hours before maturity`,
      'The record date: a clean list of who gets paid.',
    ],
    [
      'Transfers end at maturity; the token freezes on default',
      'No trading a claim that is due, late or in recourse.',
    ],
    [
      'The customer’s payment is routed by the contract',
      'The business cannot redirect it after selling the invoice.',
    ],
    [
      `${percent(assumptions.reserveBps)} of every purchase is held as a reserve`,
      'Pays the late fee, or goes to the holders on default.',
    ],
  ] as const;
  return (
    <>
      <PageHeader
        title="Investor registry"
        description="Who may hold receivable tokens. The token checks this registry on every purchase and transfer, so the rules are enforced onchain, not in Pact’s app."
      />
      <Notice tone="warning" title="A testnet stand-in for KYC" className="mb-6">
        Approval here is a demo of the registry the contract checks, with a region and an expiry. It is not
        identity verification, and Pact makes no compliance claims.
      </Notice>
      <StatGrid className="mb-6 lg:grid-cols-3">
        <Stat
          label="Approved investors"
          value={approved.length}
          hint={`${investors.length} in the registry`}
        />
        <Stat label="Held by investors" value={usd(held)} hint="Face value of open claims" />
        <Stat
          label="Refused by the contract"
          value={refusals.length}
          tone={refusals.length > 0 ? 'danger' : 'default'}
          hint="Purchases and transfers"
        />
      </StatGrid>
      <Card className="mb-6">
        <Table>
          <thead>
            <tr>
              <Th>Investor</Th>
              <Th>Region</Th>
              <Th>Status</Th>
              <Th>Approved until</Th>
              <Th align="right">Holds</Th>
              <Th align="right">
                <span className="sr-only">Action</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {investors.map(i => (
              <Tr key={i.id}>
                <Td>
                  <p className="font-medium">{i.organization}</p>
                  <p className="text-[13px] text-muted-foreground">
                    {i.name} · {i.email}
                  </p>
                </Td>
                <Td>{i.approval.region}</Td>
                <Td>
                  <Badge tone={statusTone[i.approval.status]}>{statusLabel[i.approval.status]}</Badge>
                  {i.approval.status === 'pending' && (
                    <p className="mt-1 text-[13px] text-muted-foreground">Applied {date(i.appliedAt)}</p>
                  )}
                </Td>
                <Td className="whitespace-nowrap text-muted-foreground">
                  {i.approval.expiresAt ? date(i.approval.expiresAt) : '—'}
                </Td>
                <Td align="right">
                  <p>{usd(i.heldMinor)}</p>
                  <p className="text-[13px] text-muted-foreground">
                    {i.positions} position{i.positions === 1 ? '' : 's'}
                  </p>
                </Td>
                <Td align="right">
                  <ApprovalButton
                    investorId={i.id}
                    organization={i.organization}
                    decision={i.approval.status === 'approved' ? 'revoke' : 'approve'}
                  />
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Rules the receivable token enforces" />
          <CardBody>
            <ul className="grid gap-3 text-sm">
              {rules.map(([rule, why]) => (
                <li key={rule} className="flex gap-2.5">
                  <IconShieldCheck aria-hidden className="mt-0.5 size-4.5 shrink-0 text-success" />
                  <span>
                    <span className="font-medium">{rule}</span>
                    <span className="block text-muted-foreground">{why}</span>
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Refused by the contract"
            description="Checked before sending, so a refusal costs no gas"
          />
          <CardBody>
            {refusals.length === 0 ? (
              <EmptyState icon={<IconShieldCheck />} title="Nothing refused yet">
                Purchases by investors who are not approved, and transfers to them or after the record date,
                appear here.
              </EmptyState>
            ) : (
              <Timeline
                items={refusals.map(r => ({
                  id: r.id,
                  title: `${r.invoiceNumber}: ${r.title}`,
                  detail: r.detail,
                  at: dateTime(r.at),
                  tone: 'warning',
                }))}
              />
            )}
          </CardBody>
        </Card>
      </div>
      <div className="mt-3">
        <CancelOrders role="compliance" />
      </div>
    </>
  );
}
