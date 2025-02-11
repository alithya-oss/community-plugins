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
import { readmeFactRetriever } from './readmeFactRetriever';
import { ConfigReader } from '@backstage/config';
import { GetEntitiesResponse } from '@backstage/catalog-client';
import { mockServices } from '@backstage/backend-test-utils';
import { DiscoveryService } from '@backstage/backend-plugin-api';

const getEntitiesMock = jest.fn();
jest.mock('@backstage/catalog-client', () => {
  return {
    CatalogClient: jest
      .fn()
      .mockImplementation(() => ({ getEntities: getEntitiesMock })),
  };
});

const discovery: jest.Mocked<DiscoveryService> = {
  getBaseUrl: jest.fn(),
  getExternalBaseUrl: jest.fn(),
};

const defaultEntityListResponse: GetEntitiesResponse = {
  items: [
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        name: 'backstage',
        annotations: {
          'backstage.io/source-location':
            'url:https://github.com/backstage/backstage/tree/master/',
        },
      },
      spec: {
        type: 'library',
        lifecycle: 'production',
        owner: 'CNCF',
      },
    },
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        name: 'wrong-branch',
        annotations: {
          'backstage.io/source-location':
            'url:https://github.com/backstage/backstage/tree/wrong-branch/',
        },
      },
      spec: {
        type: 'library',
        lifecycle: 'production',
        owner: 'CNCF',
      },
    },
  ],
};

const handlerContext = {
  config: ConfigReader.fromConfigs([]),
  discovery: discovery,
  logger: mockServices.logger.mock(),
  auth: mockServices.auth(),
  urlReader: mockServices.urlReader.mock(),
};

const entityFactRetriever = readmeFactRetriever;

describe('readmeFactRetriever', () => {
  beforeEach(() => {
    getEntitiesMock.mockResolvedValue(defaultEntityListResponse);
  });
  afterEach(() => {
    getEntitiesMock.mockClear();
  });

  describe('a readme file is present at the root of the source code repository', () => {
    it('returns true for the Backstage official repository', async () => {
      const facts = await entityFactRetriever.handler(handlerContext);
      expect(facts.find(it => it.entity.name === 'backstage')).toMatchObject({
        facts: {
          hasReadmeAtRepositoryRoot: true,
        },
      });
    });
  });

  describe('"backstage.io/source-location" annotation targets a inexistent branch', () => {
    it('returns false for the Backstage official repository', async () => {
      const facts = await entityFactRetriever.handler(handlerContext);
      expect(facts.find(it => it.entity.name === 'wrong-branch')).toMatchObject(
        {
          facts: {
            hasReadmeAtRepositoryRoot: false,
          },
        },
      );
    });
  });
});
