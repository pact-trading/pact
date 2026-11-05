import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Linking, Pressable, Text, TextInput, View } from 'react-native';
import { parseUsdt, pactTheme, validateCheckoutAnswers, type CheckoutAnswer, type CheckoutField, type CheckoutMetadata, type Payment, type PactClient, type PactThemeOptions } from '@pactagent/core';

export { pactTheme, pactThemePresets } from '@pactagent/core';
export type { CheckoutField, PactTheme, PactThemeOptions } from '@pactagent/core';

export type SignInMethod = 'passkey' | 'email';
export interface SignInAdapter {
  signIn(input: { method: SignInMethod; email?: string }): Promise<{ token: string }>;
}
export interface SecureStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}
export interface UsePaymentOptions {
  client: PactClient;
  returnUrl: string;
  signIn?: SignInAdapter;
  storage?: SecureStorageAdapter;
  signInMethod?: SignInMethod;
  onSuccess?: (payment: Payment) => void;
  onError?: (error: Error) => void;
}

/** Payment state plus optional identity, secure token storage, and deep-link return handling. */
export function usePayment(options: UsePaymentOptions) {
  const [payment, setPayment] = useState<Payment | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paymentRef = useRef<Payment | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    function handleUrl(url: string) {
      const current = paymentRef.current;
      if (!current || !url.startsWith(optionsRef.current.returnUrl)) return;
      const parsed = new URL(url);
      const id = parsed.searchParams.get('payment_id');
      const status = parsed.searchParams.get('status');
      if (id !== current.id || !status) return;
      const updated = { ...current, status: status as Payment['status'] };
      paymentRef.current = updated;
      setPayment(updated);
      if (status === 'succeeded') optionsRef.current.onSuccess?.(updated);
      if (status === 'failed') optionsRef.current.onError?.(new Error('Payment failed'));
    }
    const subscription = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    void Linking.getInitialURL().then((url) => { if (url) handleUrl(url); });
    return () => subscription.remove();
  }, [options.returnUrl]);

  const start = useCallback(async (amount: string, email?: string, metadata?: CheckoutMetadata) => {
    if (pending) return null;
    setPending(true);
    setError(null);
    try {
      if (parseUsdt(amount) <= 0n) throw new RangeError('Amount must be greater than zero');
      const current = optionsRef.current;
      if (current.signIn) {
        const session = await current.signIn.signIn({ method: current.signInMethod ?? 'email', email });
        if (current.storage) await current.storage.setItem('settle.session', session.token);
      }
      const created: Payment = await current.client.payments.create({ amount, email, returnUrl: current.returnUrl, ...(metadata && Object.keys(metadata).length ? { metadata } : {}) });
      paymentRef.current = created;
      setPayment(created);
      if (created.checkoutUrl) await Linking.openURL(created.checkoutUrl);
      else if (created.status === 'succeeded') current.onSuccess?.(created);
      else throw new Error('Payment is pending; a checkout link was not returned');
      return created;
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error('Could not start payment');
      setError(err.message);
      optionsRef.current.onError?.(err);
      return null;
    } finally { setPending(false); }
  }, [pending]);

  return { payment, pending, error, start };
}

export interface PactCheckoutProps extends UsePaymentOptions {
  amount: string;
  buttonLabel?: string;
  appearance?: PactThemeOptions;
  /** Extra questions shown above the pay button. Answers are sent as the payment's `metadata`. */
  fields?: CheckoutField[];
}

/** Expo-compatible checkout. Supply an API client and the app's deep-link return URL. */
export function PactCheckout({ amount, buttonLabel = 'Continue to payment', appearance, fields = [], ...options }: PactCheckoutProps) {
  const [email, setEmail] = useState('');
  const [answers, setAnswers] = useState<Record<string, CheckoutAnswer>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const { pending, error, start } = usePayment(options);
  const theme = pactTheme(appearance);
  const nativeFont = theme.font === 'Geist Variable, system-ui, sans-serif' || theme.font === 'DM Sans Variable, system-ui, sans-serif' || theme.font === 'system-ui, sans-serif' ? undefined : theme.font.split(',')[0].trim();
  return <View style={{ padding: 20, gap: 12, backgroundColor: theme.colors.surface, borderColor: theme.colors.border, borderWidth: 1, borderRadius: theme.radius }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{theme.brand.logo ? <Image source={{ uri: theme.brand.logo }} style={{ width: 32, height: 32, borderRadius: 6 }} /> : null}<Text style={{ color: theme.colors.mutedText, fontFamily: nativeFont }}>{theme.brand.name}</Text></View>
    <Text style={{ fontSize: 22, fontWeight: '500', color: theme.colors.text, fontFamily: nativeFont }}>Checkout</Text>
    <Text style={{ color: theme.colors.text, fontFamily: nativeFont }}>Total: ${amount}</Text>
    <TextInput accessibilityLabel="Email address" placeholder="Email address" placeholderTextColor={theme.colors.mutedText} keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius / 2, padding: 12, color: theme.colors.text, backgroundColor: theme.colors.background, fontFamily: nativeFont }} />
    {fields.map((item) => {
      const label = item.required ? item.label : `${item.label} (optional)`, checked = answers[item.key] === true;
      return <View key={item.key} style={{ gap: 6 }}>
        {item.type === 'checkbox'
          ? <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked }} onPress={() => setAnswers((current) => ({ ...current, [item.key]: !checked }))} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ width: 20, height: 20, borderWidth: 1, borderRadius: 4, borderColor: theme.colors.border, backgroundColor: checked ? theme.colors.primary : theme.colors.background }} /><Text style={{ color: theme.colors.text, fontFamily: nativeFont }}>{label}</Text></Pressable>
          : <TextInput accessibilityLabel={label} placeholder={label} placeholderTextColor={theme.colors.mutedText} keyboardType={item.type === 'number' ? 'numeric' : 'default'} value={String(answers[item.key] ?? '')} onChangeText={(value) => setAnswers((current) => ({ ...current, [item.key]: value }))} style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius / 2, padding: 12, color: theme.colors.text, backgroundColor: theme.colors.background, fontFamily: nativeFont }} />}
        {fieldErrors[item.key] ? <Text accessibilityRole="alert" style={{ color: theme.colors.danger }}>{fieldErrors[item.key]}</Text> : null}
      </View>;
    })}
    {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.danger }}>{error}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: pending || !email }} disabled={pending || !email} onPress={() => { const checked = validateCheckoutAnswers(fields, answers); setFieldErrors(checked.errors); if (checked.valid) void start(amount, email, checked.metadata); }} style={{ backgroundColor: theme.colors.primary, borderRadius: 9999, padding: 14, alignItems: 'center', opacity: pending || !email ? 0.5 : 1 }}><Text style={{ color: theme.colors.primaryText, fontFamily: nativeFont, fontWeight: '500' }}>{pending ? 'Starting payment…' : buttonLabel}</Text></Pressable>
  </View>;
}
