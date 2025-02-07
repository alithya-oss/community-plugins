/*
 * Copyright 2025 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { techInsightsFactRetrieversExtensionPoint } from '@backstage-community/plugin-tech-insights-node';
import { readmeFactRetriever } from './fact';

export const techInsightsModuleScm = createBackendModule({
  pluginId: 'tech-insights',
  moduleId: 'scm',
  register(reg) {
    reg.registerInit({
      deps: {
        logger: coreServices.logger,
        retrievers: techInsightsFactRetrieversExtensionPoint,
      },
      async init({ logger, retrievers }) {
        logger.info('Initializing SCM fact retriever');
        retrievers.addFactRetrievers({
          readmeFactRetriever: readmeFactRetriever,
        });
      },
    });
  },
});
