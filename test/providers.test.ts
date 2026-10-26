import { afterEach, describe, expect, it, vi } from 'vitest';
import { database } from '../src/runtime/database.ts';
import { providers } from '../src/recipes/providers/client.ts';

const settings = {
  SPOONACULAR_BASE_URL: 'https://spoon.invalid',
  SPOONACULAR_API_KEY: 'fixture',
  AZURE_TRANSLATOR_KEY: 'fixture',
  AZURE_TRANSLATOR_REGION: 'fixture',
};
const signal = () => AbortSignal.timeout(1000);
const db = () => ({ ...database(() => undefined), reserve: vi.fn(async () => true) });
const reply = (value: unknown) => new Response(JSON.stringify(value));
afterEach(() => vi.restoreAllMocks());
describe('Límites de transporte y lotes de proveedores simulados', () => {
  it('Azure divide a 100 textos y reserva caracteres UTF-16 por lote antes de enviarlos', async () => {
    const store = db();
    const transport = vi.fn<typeof fetch>(async (_url, init) =>
      reply(
        (JSON.parse(String(init?.body)) as { text: string }[]).map(({ text }) => ({
          translations: [{ text: `es:${text}` }],
        })),
      ),
    );
    const texts = Array.from({ length: 101 }, (_, i) => (i === 100 ? '😀' : 'a'));
    expect(await providers(store, settings, transport).translate(texts, 'es', signal())).toEqual(
      texts.map((text) => `es:${text}`),
    );
    expect(store.reserve.mock.calls.map((args: unknown[]) => args[1])).toEqual([100, 2]);
    expect(transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).length)).toEqual([
      100, 1,
    ]);
    expect(transport.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
    });
  });
  it('rechaza entradas de más de 50.000 caracteres y cuerpos mayores de 256 KiB sin enviar HTTP', async () => {
    const store = db();
    const transport = vi.fn<typeof fetch>();
    const provider = providers(store, settings, transport);
    await expect(provider.translate(['a'.repeat(50001)], 'es', signal())).rejects.toMatchObject({
      statusCode: 502,
    });
    // Los caracteres de control requieren escapes JSON y pueden exceder el límite de bytes.
    await expect(
      provider.translate(['\u0000'.repeat(50000)], 'es', signal()),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    { value: [] },
    { value: [{ translations: [] }] },
    { value: [{ translations: [{ text: 1 }] }] },
  ])('rechaza traducción incompleta o inválida: %j', async ({ value }) => {
    const transport = vi.fn<typeof fetch>(async () => reply(value));
    await expect(
      providers(db(), settings, transport).translate(['rice'], 'es', signal()),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
  it('sanea mapeos públicos limitando daily/search/similares a 12/12/6 y no sigue redirects', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      title: 'Title',
      image: 'image.png',
      imageType: 'jpg',
    }));
    const transport = vi.fn<typeof fetch>(async (url) =>
      reply(
        String(url).includes('/random?')
          ? { recipes: rows }
          : String(url).includes('/complexSearch?')
            ? { results: rows }
            : rows,
      ),
    );
    const provider = providers(db(), settings, transport);
    expect(await provider.daily(signal())).toHaveLength(12);
    expect(await provider.search('rice', signal())).toHaveLength(12);
    expect(await provider.similar(1, signal())).toHaveLength(6);
    expect(transport.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
    transport.mockResolvedValueOnce(
      new Response('', { status: 302, headers: { location: 'https://other.invalid' } }),
    );
    await expect(provider.detail(1, signal())).rejects.toMatchObject({ statusCode: 502 });
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it('limita respuesta declarada y streaming a 1 MiB y descarta JSON inválido', async () => {
    const cancelled = vi.fn();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024));
              controller.enqueue(new Uint8Array(1));
            },
            cancel: cancelled,
          }),
        ),
      )
      .mockResolvedValueOnce(new Response('{'));
    const provider = providers(db(), settings, transport);
    for (let i = 0; i < 3; i++)
      await expect(provider.detail(1, signal())).rejects.toMatchObject({ statusCode: 502 });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it('rechaza configuración HTTP o con credenciales sin exponerla ni contactar hosts', async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(
      providers(
        db(),
        { ...settings, SPOONACULAR_BASE_URL: 'http://private.invalid' },
        transport,
      ).detail(1, signal()),
    ).rejects.toMatchObject({ statusCode: 502, detail: 'Recipe provider unavailable.' });
    await expect(
      providers(
        db(),
        { ...settings, AZURE_TRANSLATOR_ENDPOINT: 'https://user:private@host.invalid' },
        transport,
      ).translate(['rice'], 'es', signal()),
    ).rejects.toMatchObject({ statusCode: 502, detail: 'Translation provider unavailable.' });
    expect(transport).not.toHaveBeenCalled();
  });
});
