import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { PactClient } from '@pactagent/core';
import { PactCheckout } from '../src/index.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('react-native', () => ({
  Image: 'Image', Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View',
  Linking: {
    addEventListener: () => ({ remove: () => undefined }),
    getInitialURL: async () => null,
    openURL: async () => undefined,
  },
}));

describe('Pact Pay native checkout', () => {
  it('renders the light theme, amount, and disabled action before email entry', async () => {
    const client = new PactClient({ transport: async () => ({ status: 200, body: {} }) });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<PactCheckout amount="12.50" client={client} returnUrl="golpay://payment-return" />);
    });
    const root = renderer!.root;
    expect(root.findAll((node) => String(node.type) === 'Text').map((node) => node.children.join(''))).toContain('Pact Pay');
    expect(root.findAll((node) => String(node.type) === 'Text').map((node) => node.children.join(''))).toContain('Total: $12.50');
    expect(root.find((node) => String(node.type) === 'View').props.style).toMatchObject({
      backgroundColor: '#ffffff', borderColor: '#e4e6ea', borderWidth: 1, borderRadius: 16,
    });
    expect(root.find((node) => String(node.type) === 'Pressable').props).toMatchObject({
      disabled: true, accessibilityRole: 'button', accessibilityState: { disabled: true },
    });
    await act(async () => { renderer!.unmount(); });
  });

  it('blocks payment until required fields are answered, then sends typed metadata', async () => {
    const bodies: unknown[] = [];
    const client = new PactClient({ transport: async (request) => { bodies.push(JSON.parse(String(request.body))); return { status: 200, body: { id: 'pay_1', amount: '12.50', currency: 'USDT', status: 'succeeded' } }; } });
    const onSuccess = vi.fn();
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<PactCheckout amount="12.50" client={client} returnUrl="golpay://payment-return" onSuccess={onSuccess} fields={[
        { key: 'company', label: 'Company', type: 'text', required: true },
        { key: 'seats', label: 'Seats', type: 'number' },
        { key: 'terms', label: 'Terms', type: 'checkbox', required: true },
      ]} />);
    });
    const root = renderer!.root;
    const input = (label: string) => root.find((node) => String(node.type) === 'TextInput' && node.props.accessibilityLabel === label);
    const press = (role: string) => root.find((node) => String(node.type) === 'Pressable' && node.props.accessibilityRole === role);
    const alerts = () => root.findAll((node) => String(node.type) === 'Text' && node.props.accessibilityRole === 'alert').map((node) => node.children.join(''));
    await act(async () => { input('Email address').props.onChangeText('ana@example.test'); });
    await act(async () => { press('button').props.onPress(); });
    expect(bodies).toEqual([]);
    expect(alerts()).toEqual(['Company is required.', 'Terms is required.']);
    await act(async () => { input('Company').props.onChangeText('Acme'); input('Seats (optional)').props.onChangeText('3'); press('checkbox').props.onPress(); });
    await act(async () => { press('button').props.onPress(); });
    expect(alerts()).toEqual([]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ amount: '12.50', email: 'ana@example.test', metadata: { company: 'Acme', seats: 3, terms: true } });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    await act(async () => { renderer!.unmount(); });
  });
});
