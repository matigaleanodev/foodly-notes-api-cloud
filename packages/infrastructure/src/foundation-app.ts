import { App } from 'aws-cdk-lib';
import { FoundationStack } from './foundation.ts';
const app = new App({ outdir: 'cdk.foundation.out', analyticsReporting: false });
new FoundationStack(app, 'FoodlyNotesFoundation');
app.synth();
console.info('Fundación sintetizada sin lookups, assets ni bootstrap.');
