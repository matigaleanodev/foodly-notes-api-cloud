import type { Database } from '../runtime/database.ts';
import type { Lang, StoredRecipe, Summary } from './models.ts';
import type { Providers } from './providers/client.ts';
import { safeImage, sanitizeSummary } from './content.ts';
import { SingleFlight } from '../runtime/single-flight.ts';
import {
  mapDailyRecipeSummary,
  mapRecipeDetailResponse,
  mapRecipeIngredientsResponse,
  mapRecipePersistence,
  mapSearchRecipeSummary,
} from './mapper.ts';

/** Coordina cachés y proveedores conservando contenido base cuando falla la traducción. */
export function recipeService(db: Database, provider: Providers) {
  const recipes = new SingleFlight<number, StoredRecipe>();
  const daily = new SingleFlight<string, Summary[]>();
  const translations = new SingleFlight<string, string[]>();
  const spanish = new SingleFlight<number, StoredRecipe>();
  const ingredientRequests = new SingleFlight<string, StoredRecipe[]>();

  const texts = (values: string[], targetLang: Lang, signal: AbortSignal) =>
    translations.run(JSON.stringify([targetLang, values]), async () => {
      if (!values.length) return [];
      const entries = await db.translations(values, targetLang, signal);
      const cached = new Map(entries.map((entry) => [entry.sourceText, entry.translatedText]));
      const missing = [...new Set(values.filter((text) => !cached.has(text)))];
      if (missing.length) {
        const translated = await provider.translate(missing, targetLang, signal);
        // Evitar persistir una traducción parcial aunque se use un proveedor inyectado.
        if (
          translated.length !== missing.length ||
          translated.some((text) => typeof text !== 'string')
        )
          throw new Error('Invalid translation response.');
        for (const [index, sourceText] of missing.entries()) {
          await db.insertTranslation(
            { sourceText, targetLang, translatedText: translated[index]! },
            signal,
          );
          cached.set(sourceText, translated[index]!);
        }
      }
      return values.map((value) => cached.get(value) ?? value);
    });
  const loadRecipe = (id: number, signal: AbortSignal) =>
    recipes.run(id, async () => {
      const cached = await db.recipe(id, signal);
      if (cached) return cached;
      const detail = await provider.detail(id, signal);
      return db.insertRecipe(mapRecipePersistence(id, detail), signal);
    });
  const recipeTexts = (recipe: StoredRecipe) => [
    recipe.base.title,
    recipe.base.summary,
    ...recipe.base.instructions.flatMap((block) => block.steps.map((step) => step.text)),
    ...recipe.base.ingredients.flatMap((ingredient) => [ingredient.name, ingredient.original]),
  ];
  const translateRecipes = async (values: StoredRecipe[], signal: AbortSignal) => {
    const missing = values.filter((recipe) => !recipe.translations?.es);
    if (!missing.length) return values;
    try {
      // Unificar textos evita una llamada Azure por receta y deduplica ingredientes compartidos.
      const translated = await texts(missing.flatMap(recipeTexts), 'es', signal);
      let index = 0;
      const localized = new Map<number, StoredRecipe>();
      for (const recipe of missing) {
        signal.throwIfAborted();
        const title = translated[index++]!;
        const summary = sanitizeSummary(translated[index++]!);
        const instructions = recipe.base.instructions.map((block) => ({
          name: block.name,
          steps: block.steps.map((step) => ({ number: step.number, text: translated[index++]! })),
        }));
        const ingredients = recipe.base.ingredients.map((ingredient) => ({
          ...ingredient,
          name: translated[index++]!,
          original: translated[index++]!,
        }));
        localized.set(
          recipe.sourceId,
          await db.saveSpanish(
            recipe.sourceId,
            { title, summary, instructions, ingredients, translatedAt: new Date() },
            signal,
          ),
        );
      }
      return values.map((recipe) => localized.get(recipe.sourceId) ?? recipe);
    } catch {
      // Mantener las traducciones existentes y el contenido base ante fallos o presupuesto agotado.
      return values;
    }
  };
  const translateRecipe = (recipe: StoredRecipe, signal: AbortSignal) =>
    spanish.run(recipe.sourceId, async () => (await translateRecipes([recipe], signal))[0]!);
  const localizedRecipe = async (id: number, lang: Lang, signal: AbortSignal) => {
    const recipe = await loadRecipe(id, signal);
    return lang === 'es' ? translateRecipe(recipe, signal) : recipe;
  };
  const summaries = async (values: Summary[], lang: Lang, signal: AbortSignal) => {
    const base = values.map((recipe) => ({
      sourceId: recipe.sourceId,
      title: recipe.title,
      image: safeImage(recipe.image),
    }));
    if (lang !== 'es') return base;
    try {
      const titles = await texts(
        base.map((recipe) => recipe.title),
        'es',
        signal,
      );
      return base.map((recipe, index) => ({ ...recipe, title: titles[index]! }));
    } catch {
      return base;
    }
  };
  return {
    async detail(id: number, lang: Lang, signal: AbortSignal) {
      return mapRecipeDetailResponse(await localizedRecipe(id, lang, signal), lang);
    },

    async daily(lang: Lang, signal: AbortSignal) {
      const date = new Date().toISOString().slice(0, 10);
      const values = await daily.run(date, async () => {
        const cached = await db.daily(date, signal);
        if (cached) return cached.recipes;
        const values = (await provider.daily(signal)).map(mapDailyRecipeSummary);
        return (await db.insertDaily({ date, recipes: values }, signal)).recipes;
      });
      return summaries(values, lang, signal);
    },

    async search(query: string, lang: Lang, signal: AbortSignal) {
      let normalized = query;
      if (lang === 'es') {
        try {
          normalized = (await texts([query], 'en', signal))[0]!;
        } catch {
          /* La búsqueda conserva el texto original si falla traducción. */
        }
      }
      return (await provider.search(normalized, signal)).map(mapSearchRecipeSummary);
    },

    async similar(id: number, lang: Lang, signal: AbortSignal) {
      return summaries(await provider.similar(id, signal), lang, signal);
    },

    async ingredients(ids: number[], lang: Lang, signal: AbortSignal) {
      const result = await ingredientRequests.run(JSON.stringify([ids, lang]), async () => {
        const cached = await db.recipesByIds(ids, signal);
        const byId = new Map(cached.map((recipe) => [recipe.sourceId, recipe]));
        const missing = ids.filter((id) => !byId.has(id));
        if (missing.length) {
          const loaded = await provider.details(missing, signal);
          for (const value of loaded) {
            signal.throwIfAborted();
            byId.set(
              value.id,
              await db.insertRecipe(mapRecipePersistence(value.id, value), signal),
            );
          }
        }
        const values = ids.map((id) => byId.get(id)!);
        return lang === 'es' ? translateRecipes(values, signal) : values;
      });
      return result.map((recipe) => mapRecipeIngredientsResponse(recipe, lang));
    },
  };
}
