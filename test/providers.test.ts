import { type JsonHttpClient, JsonHttpError } from '../src/runtime/http-client.ts';
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
const reply = (value: unknown) => value;
afterEach(() => vi.restoreAllMocks());
describe('Límites de transporte y lotes de proveedores simulados', () => {
  it('bulk correlaciona por id, conserva reserva por receta y no acepta IDs duplicados o ajenos', async () => {
    const store = db();
    const detail = (id: number) => ({
      id,
      title: 'Recipe',
      extendedIngredients: [],
      analyzedInstructions: [],
    });
    const transport = vi.fn<JsonHttpClient>(async () => reply([detail(2), detail(1)]));
    const api = providers(store, settings, transport);
    expect((await api.details([1, 2], signal())).map((value) => value.id)).toEqual([1, 2]);
    expect(store.reserve.mock.calls.map((args: unknown[]) => args[1])).toEqual([2]);
    expect(new URL(String(transport.mock.calls[0]?.[0])).pathname).toBe('/recipes/informationBulk');
    for (const invalid of [[detail(1), detail(1)], [detail(1), detail(3)], [{ id: 1 }]]) {
      transport.mockResolvedValueOnce(reply(invalid));
      await expect(api.details([1, 2], signal())).rejects.toMatchObject({ statusCode: 502 });
    }
    transport.mockResolvedValueOnce(reply([detail(1)]));
    await expect(api.details([1, 2], signal())).rejects.toMatchObject({ statusCode: 404 });
  });
  it('proveedores reales permanecen deshabilitados en producción salvo habilitación explícita', async () => {
    const transport = vi.fn<JsonHttpClient>();
    const store = db();
    const api = providers(store, { ...settings, NODE_ENV: 'production' }, transport);
    await expect(api.details([1, 2], signal())).rejects.toMatchObject({ statusCode: 503 });
    await expect(api.translate(['rice'], 'es', signal())).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(transport).not.toHaveBeenCalled();
    expect(store.reserve).not.toHaveBeenCalled();
  });
  it('una tanda Azure fallida espera sus llamadas y no empieza la siguiente ni reintenta', async () => {
    const store = db();
    let active = 0;
    const transport = vi.fn<JsonHttpClient>(async () => {
      active++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return reply([]);
    });
    const api = providers(store, settings, transport);
    await expect(
      api.translate(
        Array.from({ length: 501 }, (_, i) => String(i)),
        'es',
        signal(),
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(transport).toHaveBeenCalledTimes(4);
    expect(active).toBe(0);
  });
  it('Azure divide a 100 textos y reserva caracteres UTF-16 por lote antes de enviarlos', async () => {
    const store = db();
    const transport = vi.fn<JsonHttpClient>(async (_url, init) =>
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
      headers: { 'Content-Type': 'application/json' },
    });
  });
  it('rechaza entradas de más de 50.000 caracteres sin enviar HTTP', async () => {
    const store = db();
    const transport = vi.fn<JsonHttpClient>();
    const provider = providers(store, settings, transport);
    await expect(provider.translate(['a'.repeat(50001)], 'es', signal())).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    { value: [] },
    { value: [{ translations: [] }] },
    { value: [{ translations: [{ text: 1 }] }] },
  ])('rechaza traducción incompleta o inválida: %j', async ({ value }) => {
    const transport = vi.fn<JsonHttpClient>(async () => reply(value));
    await expect(
      providers(db(), settings, transport).translate(['rice'], 'es', signal()),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
  it('sanea mapeos públicos limitando daily/search/similares a 12/12/6 y conserva errores del cliente', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      title: 'Title',
      image: 'image.png',
      imageType: 'jpg',
    }));
    const transport = vi.fn<JsonHttpClient>(async (url) =>
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
    transport.mockRejectedValueOnce(new JsonHttpError('HTTP_STATUS', 302));
    await expect(provider.detail(1, signal())).rejects.toMatchObject({ statusCode: 502 });
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it('conserva imagen null si imageType está omitido o es null', async () => {
    const transport = vi.fn<JsonHttpClient>(async () => ({
      results: [
        { id: 1, title: 'Recipe', imageType: null },
        { id: 2, title: 'Recipe' },
      ],
    }));
    expect(await providers(db(), settings, transport).search('rice', signal())).toEqual([
      { id: 1, title: 'Recipe', image: null },
      { id: 2, title: 'Recipe', image: null },
    ]);
  });
  it.each([null, 1, 'text', [], { recipes: null }, { results: [{ id: 1 }] }])(
    'valida envelopes desconocidos antes de mapear: %j',
    async (value) => {
      const transport = vi.fn<JsonHttpClient>(async () => value);
      const api = providers(db(), settings, transport);
      await expect(api.daily(signal())).rejects.toMatchObject({ statusCode: 502 });
      await expect(api.search('rice', signal())).rejects.toMatchObject({ statusCode: 502 });
    },
  );
  it('rechaza configuración HTTP o con credenciales sin exponerla ni contactar hosts', async () => {
    const transport = vi.fn<JsonHttpClient>();
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
