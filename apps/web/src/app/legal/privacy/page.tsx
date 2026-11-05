import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/legal-page';

export const metadata: Metadata = { title: 'Privacy notice' };

export default function PrivacyPage() {
  return (
    <LegalPage
      current="/legal/privacy"
      title="Privacy notice"
      updated="6 November 2026"
      intro="Pact Pay is a hackathon demo, so it keeps as little as it can. This notice says what it stores, where and for how long."
      sections={[
        {
          title: 'In the demo',
          body: [
            'You do not create an account. You pick a sample viewpoint, such as the merchant or the customer, and work with sample data.',
            'Two cookies make that work: pact_sandbox names your private copy of the demo data and pact_role remembers the viewpoint you picked. Your light or dark theme choice is kept in your browser’s local storage.',
          ],
        },
        {
          title: 'What is stored',
          body: [
            'Your sandbox holds the sample records plus anything you type into the demo, such as names, email addresses, invoice lines and notes. Please do not enter real personal details.',
            'For a demo card payment only the card brand and last four digits are kept. The full number and security code are checked and then discarded.',
            'The sandbox lives in server memory or a Redis store and is deleted after 12 hours without activity, or when you press Reset in the demo bar.',
          ],
        },
        {
          title: 'Signing in with a real account',
          body: [
            'When the demo is connected to the Pact API, sign-in by email or passkey is handled by Privy, which also creates the account that pays. Pact receives your email address and account address.',
          ],
        },
        {
          title: 'Public test-network records',
          body: [
            'Payments on the Whitechain Sepolia test network are public by design. They show account addresses and amounts, never your name or email address.',
          ],
        },
        {
          title: 'No tracking',
          body: [
            'The demo has no advertising or analytics trackers. The hosting provider keeps the standard request logs any website has.',
          ],
        },
        {
          title: 'Your choices',
          body: [
            'Press Reset in the demo bar to wipe your sandbox, or clear this site’s cookies to start over with a new one.',
          ],
        },
      ]}
    />
  );
}
