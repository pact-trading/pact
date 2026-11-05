import type { Viewer } from '@pactagent/core/platform-types';

/** The people a demo visitor can view the product as. */
export const MOCK_VIEWERS: Viewer[] = [
  {
    role: 'merchant',
    userId: 'usr_maya',
    name: 'Maya Chen',
    email: 'maya@kitelabs.example',
    organization: 'Kite Labs',
  },
  {
    role: 'accountant',
    userId: 'usr_priya',
    name: 'Priya Nair',
    email: 'priya@kitelabs.example',
    organization: 'Kite Labs',
  },
  {
    role: 'customer',
    userId: 'cus_acme',
    name: 'Jordan Lee',
    email: 'jordan@acme-robotics.example',
    organization: 'Acme Robotics',
  },
  {
    role: 'investor',
    userId: 'inv_lotus',
    name: 'Arjun Mehta',
    email: 'arjun@lotuscapital.example',
    organization: 'Lotus Capital',
  },
  {
    role: 'compliance',
    userId: 'usr_elena',
    name: 'Elena Novak',
    email: 'elena@pactagent.example',
    organization: 'Pact compliance',
  },
];
