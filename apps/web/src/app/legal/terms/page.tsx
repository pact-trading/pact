import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/legal-page';

export const metadata: Metadata = { title: 'Terms of use' };

export default function TermsPage() {
  return (
    <LegalPage
      current="/legal/terms"
      title="Terms of use"
      updated="6 November 2026"
      intro="Pact Pay is a hackathon demo. It shows how a business could take payments, invoices, subscriptions and refunds in USDT on the Whitechain Sepolia test network. Nothing here moves real money. By using it you accept the plain terms below."
      sections={[
        {
          title: 'What this is',
          body: [
            'Pact Pay is a prototype built for a hackathon. It is not a bank, a licensed payment service or a money transmitter, and it does not hold funds for anyone.',
            'Use it to evaluate the product. Do not use it to sell real goods or to pay for anything real.',
          ],
        },
        {
          title: 'No real money',
          body: [
            'Balances, payments, refunds and fees use test USDT on a test network, or records in a simulated sandbox. Test tokens have no value and cannot be exchanged for money.',
            'In the demo, the card, bank transfer and own-wallet options are simulations labelled “Demo”. No card is charged, no bank is contacted and no transfer is watched for. Use the test card numbers shown on the form and never enter a real card.',
          ],
        },
        {
          title: 'Who you are dealing with',
          body: [
            'The businesses, customers and investors in the demo are sample personas. When a business connects its own test account, that business is responsible for what it offers and for its refund policy.',
          ],
        },
        {
          title: 'Subscriptions and limits',
          body: [
            'A subscription asks you to sign a cap: the most the business may charge each period and for how many periods. The test-network contract refuses any charge above the cap, before it is due or after you cancel.',
            'You can cancel from your account at any time. Cancelling stops future charges.',
          ],
        },
        {
          title: 'Refunds',
          body: [
            'Refunds are decided by the business within its refund window. Each refund is recorded and shown on your receipt.',
          ],
        },
        {
          title: 'Availability and resets',
          body: [
            'The demo can change, reset or go offline at any time. Each visitor’s sandbox is deleted after 12 hours without activity, and every new release starts everyone from the sample data again.',
          ],
        },
        {
          title: 'No warranty',
          body: [
            'The demo is provided as is, without any warranty. To the extent the law allows, the team that built it is not liable for any loss from using it.',
          ],
        },
        {
          title: 'Changes',
          body: ['We may update these terms. The date at the top shows the current version.'],
        },
      ]}
    />
  );
}
