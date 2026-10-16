/** Example provider for an operator-managed reverse proxy already forwarding to a fixed local origin. */
import { CallbackTunnel, CallbackError } from '@deepseek-ai/dsh-experimental-security-callbacks'
import z from '@deepseek-ai/schemastery'

export default class CustomCallbackTunnel extends CallbackTunnel {
  static Config = z.object({ publicUrl: z.string().min(1), localUrl: z.string().min(1) })

  constructor(ctx, config) {
    super(ctx)
    const url = new URL(config.publicUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new CallbackError('CALLBACK_UNAVAILABLE', 'Configure the HTTPS origin of the existing reverse proxy.')
    }
    this.config = { ...config, publicUrl: url.origin }
  }

  async open(localUrl, signal) {
    signal.throwIfAborted()
    if (new URL(localUrl).origin !== new URL(this.config.localUrl).origin) {
      throw new CallbackError('CALLBACK_UNAVAILABLE', 'The reverse proxy upstream must match the configured receiver listener.')
    }
    // This provider acquires no remote resource; the operator owns the existing reverse proxy.
    return { url: this.config.publicUrl, close: async () => {} }
  }
}
