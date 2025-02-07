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
  LoggerService,
  UrlReaderService,
  CacheService,
} from '@backstage/backend-plugin-api';
import { ScmIntegrations } from '@backstage/integration';
import { CacheManager } from '@backstage/backend-defaults/cache';
import {
  FactRetriever,
  FactRetrieverContext,
} from '@backstage-community/plugin-tech-insights-node';
import { CatalogClient } from '@backstage/catalog-client';
import {
  Entity,
  getEntitySourceLocation,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import { UrlReaders } from '@backstage/backend-defaults/urlReader';
import { isError } from '@backstage/errors';
import gitUrlParse from 'git-url-parse';
import pThrottle from 'p-throttle';

// 1 request per second
const throttle = pThrottle({
  limit: 1,
  interval: 1000,
});

/** @private */
const throttledCheckReadmeAtRepositoryRoot = throttle(
  async (
    entity: Entity,
    logger: LoggerService,
    integrations: ScmIntegrations,
    reader: UrlReaderService,
    cache: CacheService,
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    return await checkReadmeAtRepositoryRoot(
      entity,
      logger,
      integrations,
      reader,
      cache,
    );
  },
);

export interface FileType {
  name: string;
  type: string;
}

export interface ReadmeFile extends FileType {
  content: string;
}

// Cache placeholder for entities where no readme
export const NOT_FOUND_PLACEHOLDER = 'NOT_FOUND';
export const DEFAULT_TTL = 1800 * 1000;

export const README_TYPES: FileType[] = [
  // { name: 'README', type: 'text/plain' },
  { name: 'README.md', type: 'text/markdown' },
  // { name: 'README.rst', type: 'text/plain' },
  // { name: 'README.txt', type: 'text/plain' },
  // { name: 'README.MD', type: 'text/markdown' },
];

const DETECT_SYMLINKS_REGEX = '^(w+|.|/|-)+$';

export const isSymLink = (content: string): boolean => {
  const lines = content.split('\n');
  if (lines.length > 1) return false;
  const line = lines[0];
  if (line.includes(' ')) return false;

  const regex = RegExp(DETECT_SYMLINKS_REGEX);
  return regex.test(content);
};

export const checkReadmeAtRepositoryRoot = async (
  entity: Entity,
  logger: LoggerService,
  integrations: ScmIntegrations,
  reader: UrlReaderService,
  cache: CacheService,
): Promise<Boolean> => {
  // Entity data
  const namespace = entity.metadata.namespace ?? 'default';
  const kind = entity.kind;
  const name = entity.metadata.name;
  const entityRef = stringifyEntityRef({ kind, namespace, name });
  const cacheDoc = (await cache.get(entityRef)) as ReadmeFile | undefined;

  if (cacheDoc && cacheDoc.name === NOT_FOUND_PLACEHOLDER) {
    logger.debug('README file not found in cache');
  }
  if (cacheDoc) {
    logger.info(`README check successful for cached entity: "${entityRef}"`);
    return true;
  }

  // Retreive entity source location
  const source = getEntitySourceLocation(entity);

  if (!source || source.type !== 'url') {
    const errorMessage = `Not valid location for ${source.target}`;
    logger.info(errorMessage);
  }
  const integration = integrations.byUrl(source.target);

  if (!integration) {
    logger.error(`No integration found for ${source.target}`);
    return false;
  }

  // Cleanup source location
  const { resource, name: repo, owner, ref } = gitUrlParse(source.target);

  // Check for supported README files
  for (const fileType of README_TYPES) {
    const url = integration.resolveUrl({
      url: `https://${resource}/${owner}/${repo}/blob/${ref}/${fileType.name}`,
      base: source.target,
    });

    let content;

    try {
      logger.debug(
        `Checking README for entity "${entityRef}" location: ${url}`,
      );

      const response = await reader.readUrl(url);
      content = (await response.buffer()).toString('utf-8');

      if (isSymLink(content)) {
        const symLinkUrl = integration.resolveUrl({
          url: content,
          base: source.target,
        });
        const symLinkUrlResponse = await reader.readUrl(symLinkUrl);
        content = (await symLinkUrlResponse.buffer()).toString('utf-8');
      }

      cache.set(entityRef, {
        name: fileType.name,
        type: fileType.type,
        content: content,
      });

      logger.debug(
        `README check successful for entity: "${entityRef}" location: "${url}"`,
      );

      return true;
    } catch (error: unknown) {
      if (isError(error) && error.name === 'NotFoundError') {
        continue;
      } else {
        logger.info(
          `README check failed for entity: "${entityRef}" error: "${error}"`,
        );
      }
    }

    cache.set(entityRef, {
      name: NOT_FOUND_PLACEHOLDER,
      type: '',
      content: '',
    });
  }

  return false;
};

export const readmeFactRetriever: FactRetriever = {
  id: 'readmeFactRetriever',
  version: '0.2.0',
  title: 'README',
  description:
    'Generate facts which indicates the compliance of a README file a the root of the repo',
  // TODO: Add { kind: 'api' } once workaround found for the compatibility with OpenAPI backend module  (@fjudith)
  entityFilter: [{ kind: 'component' }, { kind: 'system' }],
  schema: {
    hasReadmeAtRepositoryRoot: {
      type: 'boolean',
      description:
        'The entity source repository contains a README file at the root',
    },
  },
  handler: async ({
    discovery,
    entityFilter,
    auth,
    logger,
    config,
  }: FactRetrieverContext) => {
    const { token } = await auth.getPluginRequestToken({
      onBehalfOf: await auth.getOwnServiceCredentials(),
      targetPluginId: 'catalog',
    });

    const catalogClient = new CatalogClient({
      discoveryApi: discovery,
    });

    const entities = await catalogClient.getEntities(
      { filter: entityFilter },
      { token },
    );

    const pluginCache =
      CacheManager.fromConfig(config).forPlugin('tech-insights');
    const cache = pluginCache.withOptions({ defaultTtl: DEFAULT_TTL });

    const integrations = ScmIntegrations.fromConfig(config);

    const reader: UrlReaderService = UrlReaders.default({ config, logger });

    return await Promise.all(
      entities.items.map(async (entity: Entity) => {
        return {
          entity: {
            namespace: entity.metadata.namespace!,
            kind: entity.kind,
            name: entity.metadata.name,
          },
          facts: {
            hasReadmeAtRepositoryRoot: Boolean(
              (await throttledCheckReadmeAtRepositoryRoot(
                entity,
                logger,
                integrations,
                reader,
                cache,
              )) || false,
            ),
          },
        };
      }),
    );
  },
};
