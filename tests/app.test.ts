import { describe, expect, it } from 'vitest';
import { splitInput, confirmBatch } from '../src/app.js';
import type { PromptPort } from '../src/prompts.js';
import { redact } from '../src/core/safety.js';
import { ProcessRunner } from '../src/core/process.js';
const prompt = (answer: boolean, interactive = true): PromptPort => ({
  interactive,
  select: async () => '',
  multiselect: async () => [],
  confirm: async () => answer,
  text: async () => '',
  note: () => {},
});
describe('universal input workflow', () => {
  it('accepts pasted URLs separated by newlines or spaces', () => {
    expect(
      splitInput(
        'https://youtu.be/abcdefghijk\nhttps://open.spotify.com/track/1234567890123456789012',
      ),
    ).toEqual({
      urls: [
        'https://youtu.be/abcdefghijk',
        'https://open.spotify.com/track/1234567890123456789012',
      ],
    });
    expect(splitInput('A song by an artist')).toEqual({ query: 'A song by an artist' });
  });
  it('rejects a mixture of URLs and accidental pasted text', () => {
    expect(() => splitInput('https://example.org/a.mp3 stray')).toThrow('URLs');
  });
  it('requires explicit large-batch approval even without a terminal', async () => {
    expect(await confirmBatch(21, 20, false, prompt(false))).toBe(false);
    await expect(confirmBatch(21, 20, false, prompt(false, false))).rejects.toThrow('--yes');
    expect(await confirmBatch(21, 20, true, prompt(false, false))).toBe(true);
    expect(await confirmBatch(1, 20, false, prompt(false, false))).toBe(true);
  });
});
describe('safe subprocess boundary', () => {
  it('keeps public YouTube identity parameters while removing token parameters', () => {
    expect(redact('https://www.youtube.com/watch?v=abcdefghijk&list=PL123&token=secret')).toBe(
      'https://www.youtube.com/watch?v=abcdefghijk&list=PL123',
    );
  });
  it('passes shell metacharacters literally', async () => {
    const runner = new ProcessRunner();
    const result = await runner.run(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1])',
      '$(echo injected); `echo bad` & | >',
    ]);
    expect(result.stdout).toBe('$(echo injected); `echo bad` & | >');
  });
  it('aborts a running child before returning', async () => {
    const controller = new AbortController();
    const pending = new ProcessRunner().run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 40);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  it('removes cookies, tokens and credential-bearing query strings from errors', () => {
    const output = redact(
      'cookie=secret token: abc https://user:pass@example.org/a?access_token=hidden',
    );
    expect(output).not.toMatch(/secret|abc|pass|hidden/);
    expect(output).toContain('https://example.org/a');
  });
  it('redacts complete authorization and cookie headers', () => {
    const output = redact(
      'Authorization: Bearer bearer-secret\nCookie: a=cookie-secret; b=other-secret\nclient_secret=client-secret',
    );
    expect(output).not.toMatch(/bearer-secret|cookie-secret|other-secret|client-secret/);
  });
  it('preserves Unicode when subprocess output splits a UTF-8 code point', async () => {
    const result = await new ProcessRunner().run(process.execPath, [
      '-e',
      "const b=Buffer.from('Đêm nhạc');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),30)",
    ]);
    expect(result.stdout).toBe('Đêm nhạc');
  });
});
