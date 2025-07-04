/*
 * Copyright 2023 The Backstage Authors
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
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './service/router';
import { azureDevOpsPermissions } from '@backstage-community/plugin-azure-devops-common';

/**
 * Azure DevOps backend plugin
 *
 * @public
 */
export const azureDevOpsPlugin = createBackendPlugin({
  pluginId: 'azure-devops',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        reader: coreServices.urlReader,
        permissions: coreServices.permissions,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        permissionsRegistry: coreServices.permissionsRegistry,
      },
      async init({
        config,
        logger,
        reader,
        permissions,
        httpRouter,
        httpAuth,
        permissionsRegistry,
      }) {
        httpRouter.use(
          await createRouter({
            config,
            logger,
            reader,
            permissions,
            httpAuth,
          }),
        );
        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated',
        });
        permissionsRegistry.addPermissions(azureDevOpsPermissions);
      },
    });
  },
});
