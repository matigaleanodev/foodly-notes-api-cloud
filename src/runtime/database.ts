import { createConnection, type Connection, Schema } from 'mongoose';
import {
  recipeSchema,
  dailySchema,
  translationSchema,
  isDuplicateKey,
  type StoredRecipe,
  type DailyRecipe,
  type TranslationEntry,
  type Content,
  type Lang,
} from '../recipes/models.ts';

interface Counter {
  _id: string;
  count: number;
  expiresAt: Date;
}
const counterSchema = new Schema<Counter>(
  { _id: String, count: Number, expiresAt: Date },
  { collection: 'securitycounters' },
);
counterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'security_counter_expiry' });

/** Reutiliza la conexión Mongo por instancia; las operaciones reciben cancelación y no crean índices. */
export function database(
  uri: () => string | undefined | Promise<string | undefined>,
  maxPoolSize = 4,
) {
  let opening: Promise<Connection> | undefined;
  const connect = () => {
    opening ??= (async () => {
      const value = await uri();
      if (!value) throw new Error('MONGO_URI required.');
      const connection = createConnection(value, {
        autoIndex: false,
        autoCreate: false,
        bufferCommands: false,
        minPoolSize: 0,
        maxPoolSize,
        maxIdleTimeMS: 60000,
        serverSelectionTimeoutMS: 2000,
        connectTimeoutMS: 2000,
        socketTimeoutMS: 3000,
        timeoutMS: 3000,
      });
      try {
        return await connection.asPromise();
      } catch (error) {
        await connection.close().catch(() => undefined);
        throw error;
      }
    })().catch((error: unknown) => {
      opening = undefined;
      throw error;
    });
    return opening;
  };
  const models = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const connection = await connect();
    signal.throwIfAborted();
    return {
      recipes: connection.model('StoredRecipe', recipeSchema),
      daily: connection.model('DailyRecipe', dailySchema),
      translations: connection.model('TranslationEntry', translationSchema),
      counters: connection.model('SecurityCounter', counterSchema),
    };
  };
  const options = (signal: AbortSignal) => ({ signal, maxTimeMS: 2000 });
  return {
    connect,

    async list(limit: number, after: number | undefined, signal: AbortSignal) {
      const { recipes } = await models(signal);
      return recipes
        .find(after === undefined ? {} : { sourceId: { $gt: after } })
        .select('sourceId base.title meta.image -_id')
        .sort({ sourceId: 1 })
        .limit(limit)
        .setOptions(options(signal))
        .lean<Pick<StoredRecipe, 'sourceId' | 'base' | 'meta'>[]>()
        .exec();
    },

    /** Lee el lote sin consultas individuales; el servicio conserva el orden solicitado. */
    async recipesByIds(ids: number[], signal: AbortSignal) {
      const { recipes } = await models(signal);
      return recipes
        .find({ sourceId: { $in: ids } })
        .setOptions(options(signal))
        .lean<StoredRecipe[]>()
        .exec();
    },

    /** Comprueba conectividad/autenticación sin escribir ni consumir cuotas. */
    async ping(signal: AbortSignal) {
      signal.throwIfAborted();
      const connection = await connect();
      signal.throwIfAborted();
      await connection.db!.command({ ping: 1 }, { signal, timeoutMS: 1500 });
    },

    async recipe(sourceId: number, signal: AbortSignal) {
      const { recipes } = await models(signal);
      return recipes.findOne({ sourceId }).setOptions(options(signal)).lean<StoredRecipe>().exec();
    },

    async insertRecipe(
      value: Pick<StoredRecipe, 'sourceId' | 'base' | 'meta'>,
      signal: AbortSignal,
    ) {
      const { recipes } = await models(signal);
      try {
        return await recipes
          .findOneAndUpdate(
            { sourceId: value.sourceId },
            { $setOnInsert: value },
            {
              ...options(signal),
              upsert: true,
              returnDocument: 'after',
              setDefaultsOnInsert: true,
            },
          )
          .lean<StoredRecipe>()
          .orFail()
          .exec();
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        return recipes
          .findOne({ sourceId: value.sourceId })
          .setOptions(options(signal))
          .lean<StoredRecipe>()
          .orFail()
          .exec();
      }
    },

    /** Conserva la primera traducción persistida sin sobrescribir la de otra request concurrente. */
    async saveSpanish(
      sourceId: number,
      translated: Content & { translatedAt: Date },
      signal: AbortSignal,
    ) {
      const { recipes } = await models(signal);
      await recipes
        .updateOne(
          { sourceId, 'translations.es': { $exists: false } },
          { $set: { 'translations.es': translated } },
          options(signal),
        )
        .exec();
      return recipes
        .findOne({ sourceId })
        .setOptions(options(signal))
        .lean<StoredRecipe>()
        .orFail()
        .exec();
    },

    async daily(date: string, signal: AbortSignal) {
      const { daily } = await models(signal);
      return daily.findOne({ date }).setOptions(options(signal)).lean<DailyRecipe>().exec();
    },

    async insertDaily(value: DailyRecipe, signal: AbortSignal) {
      const { daily } = await models(signal);
      try {
        return await daily
          .findOneAndUpdate(
            { date: value.date },
            { $setOnInsert: value },
            {
              ...options(signal),
              upsert: true,
              returnDocument: 'after',
              setDefaultsOnInsert: true,
            },
          )
          .lean<DailyRecipe>()
          .orFail()
          .exec();
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        return daily
          .findOne({ date: value.date })
          .setOptions(options(signal))
          .lean<DailyRecipe>()
          .orFail()
          .exec();
      }
    },

    async translations(texts: string[], targetLang: Lang, signal: AbortSignal) {
      const { translations } = await models(signal);
      return translations
        .find({ sourceText: { $in: texts }, targetLang })
        .setOptions(options(signal))
        .lean<TranslationEntry[]>()
        .exec();
    },

    async insertTranslation(value: TranslationEntry, signal: AbortSignal) {
      const { translations } = await models(signal);
      try {
        await translations
          .updateOne(
            { sourceText: value.sourceText, targetLang: value.targetLang },
            { $setOnInsert: value },
            { ...options(signal), upsert: true },
          )
          .exec();
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    },

    /** Reserva presupuesto de forma atómica; devuelve false si las unidades exceden el saldo. */
    async reserve(key: string, units: number, limit: number, expiresAt: Date, signal: AbortSignal) {
      const { counters } = await models(signal);
      try {
        await counters
          .updateOne(
            { _id: key },
            { $setOnInsert: { count: 0, expiresAt } },
            { ...options(signal), upsert: true },
          )
          .exec();
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
      signal.throwIfAborted();
      return Boolean(
        await counters
          .findOneAndUpdate(
            { _id: key, count: { $lte: limit - units } },
            { $inc: { count: units } },
            { ...options(signal), returnDocument: 'after' },
          )
          .lean<Counter>()
          .exec(),
      );
    },

    async increment(key: string, expiresAt: Date, signal: AbortSignal) {
      const { counters } = await models(signal);
      const counter = await counters
        .findOneAndUpdate(
          { _id: key },
          { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
          {
            ...options(signal),
            upsert: true,
            returnDocument: 'after',
            setDefaultsOnInsert: false,
          },
        )
        .lean<Counter>()
        .exec();
      if (!counter) throw new Error('Missing counter.');
      return counter.count;
    },

    async close() {
      const connection = await opening;
      opening = undefined;
      await connection?.close();
    },
  };
}

export type Database = ReturnType<typeof database>;
