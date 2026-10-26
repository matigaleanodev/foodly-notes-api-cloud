import { createConnection, type Connection, Schema } from 'mongoose';

interface StoredRecipe {
  sourceId: number;
  base: { title: string };
  meta?: { image?: string | null };
}
interface Counter {
  _id: string;
  count: number;
  expiresAt: Date;
}

// Solo lectura del listado; el esquema completo se traslada junto con detalle/traducción.
const recipeSchema = new Schema<StoredRecipe>(
  {
    sourceId: Number,
    base: { title: String },
    meta: { image: String },
  },
  { collection: 'recipes' },
);
const counterSchema = new Schema<Counter>(
  {
    _id: String,
    count: Number,
    expiresAt: Date,
  },
  { collection: 'securitycounters' },
);
counterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'security_counter_expiry' });

export function database(uri: () => string | undefined) {
  let opening: Promise<Connection> | undefined;
  const connect = () => {
    opening ??= (async () => {
      const value = uri();
      if (!value) throw new Error('MONGO_URI required.');
      const connection = createConnection(value, {
        autoIndex: false,
        autoCreate: false,
        bufferCommands: false,
        minPoolSize: 0,
        maxPoolSize: 4,
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
  return {
    connect,
    async list(limit: number, after: number | undefined, signal: AbortSignal) {
      const connection = await connect();
      signal.throwIfAborted();
      const recipes =
        connection.models.StoredRecipe ?? connection.model('StoredRecipe', recipeSchema);
      return recipes
        .find(after === undefined ? {} : { sourceId: { $gt: after } })
        .select('sourceId base.title meta.image -_id')
        .sort({ sourceId: 1 })
        .limit(limit)
        .setOptions({ signal, maxTimeMS: 2000 })
        .lean<StoredRecipe[]>()
        .exec();
    },
    async increment(key: string, expiresAt: Date, signal: AbortSignal) {
      const connection = await connect();
      signal.throwIfAborted();
      const counters =
        connection.models.SecurityCounter ?? connection.model('SecurityCounter', counterSchema);
      const counter = await counters
        .findOneAndUpdate(
          { _id: key },
          { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
          {
            upsert: true,
            returnDocument: 'after',
            setDefaultsOnInsert: false,
            signal,
            maxTimeMS: 2000,
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
