import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { PactClient } from '@pactagent/core';
// The web SDK has no test runner of its own; this package already has the renderer it needs.
import { Checkout } from '../../checkout-react/src/index.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('React checkout fields', () => {
  it('blocks payment until required fields are answered, then sends typed metadata', async () => {
    const bodies: unknown[] = [];
    const client = new PactClient({ transport: async (request) => { bodies.push(JSON.parse(String(request.body))); return { status: 200, body: { id: 'pay_1', amount: '12.50', currency: 'USDT', status: 'succeeded' } }; } });
    const onSuccess = vi.fn();
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Checkout amount="12.50" client={client} onSuccess={onSuccess} fields={[
        { key: 'company', label: 'Company', type: 'text', required: true },
        { key: 'seats', label: 'Seats', type: 'number' },
        { key: 'terms', label: 'Terms', type: 'checkbox', required: true },
      ]} />);
    });
    const root = renderer!.root;
    const input = (id: string) => root.findByProps({ id });
    const submit = () => act(async () => { await root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    const alerts = () => root.findAll((node) => node.type === 'p' && node.props.role === 'alert').map((node) => node.children.join(''));
    await act(async () => { input('pact-email').props.onChange({ target: { value: 'ana@example.test' } }); });
    await submit();
    expect(bodies).toEqual([]);
    expect(alerts()).toEqual(['Company is required.', 'Terms is required.']);
    expect(root.findAll((node) => node.type === 'input').map((node) => node.props.type)).toEqual(['email', 'text', 'number', 'checkbox']);
    await act(async () => {
      input('pact-field-company').props.onChange({ target: { value: ' Acme ' } });
      input('pact-field-seats').props.onChange({ target: { value: '3' } });
      input('pact-field-terms').props.onChange({ target: { checked: true } });
    });
    await submit();
    expect(alerts()).toEqual([]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ amount: '12.50', email: 'ana@example.test', metadata: { company: 'Acme', seats: 3, terms: true } });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    await act(async () => { renderer!.unmount(); });
  });
});
