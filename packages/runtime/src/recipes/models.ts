import { Schema } from 'mongoose';

export type Lang = 'en' | 'es';

export interface Content {
  title: string;
  summary: string;
  instructions: { name: string; steps: { number: number; text: string }[] }[];
  ingredients: {
    id: number;
    name: string;
    original: string;
    amount: number;
    unit: string;
    image?: string;
  }[];
}

export interface StoredRecipe {
  sourceId: number;
  source: string;
  originalLang: string;
  base: Content;
  meta: {
    image?: string;
    readyInMinutes?: number;
    servings?: number;
    vegetarian?: boolean;
    vegan?: boolean;
    glutenFree?: boolean;
    dairyFree?: boolean;
    cookingMinutes?: number;
    preparationMinutes?: number;
    healthScore?: number;
    aggregateLikes?: number;
    sourceName?: string;
    sourceUrl?: string;
  };
  translations: Record<string, Content & { translatedAt: Date }>;
}

export interface Summary {
  sourceId: number;
  title: string;
  image?: string | null;
}

export interface DailyRecipe {
  date: string;
  recipes: Summary[];
}

export interface TranslationEntry {
  sourceText: string;
  targetLang: Lang;
  translatedText: string;
}

export const recipeSchema = new Schema<StoredRecipe>(
  {
    sourceId: { type: Number, required: true },
    source: { type: String, default: 'spoonacular' },
    originalLang: { type: String, default: 'en' },
    base: {
      type: {
        title: String,
        summary: String,
        instructions: [{ name: String, steps: [{ number: Number, text: String }] }],
        ingredients: [
          {
            id: Number,
            name: String,
            original: String,
            amount: Number,
            unit: String,
            image: String,
          },
        ],
      },
      required: true,
    },
    meta: {
      type: {
        image: String,
        readyInMinutes: Number,
        servings: Number,
        vegetarian: Boolean,
        vegan: Boolean,
        glutenFree: Boolean,
        dairyFree: Boolean,
        cookingMinutes: Number,
        preparationMinutes: Number,
        healthScore: Number,
        aggregateLikes: Number,
        sourceName: String,
        sourceUrl: String,
      },
    },
    translations: { type: Object, default: {} },
  },
  { collection: 'recipes', timestamps: true },
);

recipeSchema.index({ sourceId: 1 }, { unique: true, name: 'recipe_source_unique' });

export const dailySchema = new Schema<DailyRecipe>(
  {
    date: { type: String, required: true },
    recipes: { type: [{ sourceId: Number, title: String, image: String }], required: true },
  },
  { collection: 'dailyrecipes', timestamps: true },
);

dailySchema.index({ date: 1 }, { unique: true, name: 'daily_date_unique' });

export const translationSchema = new Schema<TranslationEntry>(
  {
    sourceText: { type: String, required: true, index: true },
    targetLang: { type: String, required: true, index: true },
    translatedText: { type: String, required: true },
  },
  { collection: 'translationentries', timestamps: true },
);

translationSchema.index({ sourceText: 1, targetLang: 1 }, { unique: true });
translationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 2592000, name: 'translation_cache_expiry' },
);

export function isDuplicateKey(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
