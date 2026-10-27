import { App } from 'aws-cdk-lib';
import { deploymentConfiguration } from './config.ts';
import { FoodlyNotesStack } from './stack.ts';

const app = new App({ analyticsReporting: false });
new FoodlyNotesStack(app, 'FoodlyNotesTest', {
  configuration: deploymentConfiguration(process.env),
});
app.synth();
