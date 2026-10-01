/*
 * Copyright 2022 The Backstage Authors
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
  EntitiesOverview,
  EntityResults,
  Language,
  Languages,
  LINGUIST_ANNOTATION,
} from '@backstage-community/plugin-linguist-common';
import {
  CATALOG_FILTER_EXISTS,
  CatalogApi,
  GetEntitiesRequest,
} from '@backstage/catalog-client';
import { UrlReaderService } from '@backstage/backend-plugin-api';

import { DateTime } from 'luxon';
import { LinguistBackendStore } from '../db';
import fs from 'fs-extra';
import linguist from 'linguist-js';
import {
  ANNOTATION_SOURCE_LOCATION,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import { assertError } from '@backstage/errors';
import { HumanDuration } from '@backstage/types';
import { Results } from 'linguist-js/dist/types';
import { type AuthService, LoggerService } from '@backstage/backend-plugin-api';

/** @public */
export interface LinguistBackendApi {
  getEntityLanguages(entityRef: string): Promise<Languages>;
  processEntities(): Promise<void>;
}

/** @public */
export class LinguistBackendClient implements LinguistBackendApi {
  private readonly logger: LoggerService;
  private readonly store: LinguistBackendStore;
  private readonly urlReader: UrlReaderService;
  private readonly auth: AuthService;

  private readonly catalogApi: CatalogApi;
  private readonly age?: HumanDuration;
  private readonly batchSize?: number;
  private readonly useSourceLocation?: boolean;
  private readonly kind: string[];
  private readonly linguistJsOptions?: Record<string, unknown>;

  // Number of additional attempts after the first before giving up on an
  // entity. Kept as internal constants so transient-failure handling behaves
  // consistently without expanding the public constructor signature.
  private readonly maxRetries = 2;
  private readonly retryBaseDelayMs = 1000;

  public constructor(
    logger: LoggerService,
    store: LinguistBackendStore,
    urlReader: UrlReaderService,
    auth: AuthService,
    catalogApi: CatalogApi,
    age?: HumanDuration,
    batchSize?: number,
    useSourceLocation?: boolean,
    kind?: string[],
    linguistJsOptions?: Record<string, unknown>,
  ) {
    this.logger = logger;
    this.store = store;
    this.urlReader = urlReader;
    this.auth = auth;
    this.catalogApi = catalogApi;
    this.batchSize = batchSize;
    this.age = age;
    this.useSourceLocation = useSourceLocation;
    this.kind = kindOrDefault(kind);
    this.linguistJsOptions = linguistJsOptions;
  }

  async getEntityLanguages(entityRef: string): Promise<Languages> {
    this.logger?.debug(`Getting languages for entity "${entityRef}"`);

    return this.store.getEntityResults(entityRef);
  }

  async processEntities(): Promise<void> {
    this.logger?.info('Synchronizing list of entities');
    await this.synchronizeEntitiesWithCatalog();

    this.logger?.info('Processing applicable entities through Linguist');
    await this.generateEntitiesLanguages();
  }

  /** @internal */
  async synchronizeEntitiesWithCatalog(): Promise<void> {
    this.logger?.info(
      'Synchronizing entities between Catalog and Linguist store',
    );

    const annotationKey = this.useSourceLocation
      ? ANNOTATION_SOURCE_LOCATION
      : LINGUIST_ANNOTATION;
    const request: GetEntitiesRequest = {
      filter: {
        kind: this.kind,
        [`metadata.annotations.${annotationKey}`]: CATALOG_FILTER_EXISTS,
      },
      fields: ['kind', 'metadata'],
    };

    const { token } = await this.auth.getPluginRequestToken({
      onBehalfOf: await this.auth.getOwnServiceCredentials(),
      targetPluginId: 'catalog',
    });
    const response = await this.catalogApi.getEntities(request, { token });
    const catalogEntities = response.items;

    const catalogEntityRefs = new Set(
      catalogEntities.map(entity => stringifyEntityRef(entity)),
    );

    const storedEntityRefs = new Set(await this.store.getAllEntities());

    const entitiesToAdd = [...catalogEntityRefs].filter(
      entityRef => !storedEntityRefs.has(entityRef),
    );

    const entitiesToRemove = [...storedEntityRefs].filter(
      entityRef => !catalogEntityRefs.has(entityRef),
    );

    if (entitiesToAdd.length > 0) {
      this.logger?.info(`Adding ${entitiesToAdd.length} new entities`);
      await Promise.all(
        entitiesToAdd.map(entityRef => this.store.insertNewEntity(entityRef)),
      );
    }

    if (entitiesToRemove.length > 0) {
      this.logger?.info(`Removing ${entitiesToRemove.length} stale entities`);
      for (const entityRef of entitiesToRemove) {
        this.logger?.info(
          `Entity ${entityRef} was not found in the Catalog, it will be deleted`,
        );
        await this.store.deleteEntity(entityRef);
      }
    }

    this.logger?.info(
      `Synchronization complete: ${entitiesToAdd.length} added, ${entitiesToRemove.length} removed, ${catalogEntityRefs.size} total in catalog`,
    );
  }

  /** @internal */
  async generateEntitiesLanguages(): Promise<void> {
    const entitiesOverview = await this.getEntitiesOverview();
    this.logger?.info(
      `Entities overview: Entity: ${entitiesOverview.entityCount}, Processed: ${entitiesOverview.processedCount}, Pending: ${entitiesOverview.pendingCount}, Stale ${entitiesOverview.staleCount}`,
    );

    const entities = entitiesOverview.filteredEntities.slice(
      0,
      this.batchSize ?? 20,
    );

    for (const entityRef of entities) {
      const { token } = await this.auth.getPluginRequestToken({
        onBehalfOf: await this.auth.getOwnServiceCredentials(),
        targetPluginId: 'catalog',
      });
      const entity = await this.catalogApi.getEntityByRef(entityRef, {
        token,
      });
      const annotationKey = this.useSourceLocation
        ? ANNOTATION_SOURCE_LOCATION
        : LINGUIST_ANNOTATION;

      let url = entity?.metadata.annotations?.[annotationKey] ?? '';
      if (url.startsWith('url:')) {
        url = url.slice(4);
      }

      try {
        await this.generateEntityLanguages(entityRef, url);
      } catch (error) {
        assertError(error);
        this.logger.error(
          `Unable to process "${entityRef}" using "${url}", message: ${error.message}, stack: ${error.stack}`,
        );
      }
    }
  }

  /** @internal */
  async getEntitiesOverview(): Promise<EntitiesOverview> {
    this.logger?.debug('Getting pending entities');

    const processedEntities = await this.store.getProcessedEntities();
    const staleEntities = processedEntities
      .filter(pe => {
        if (this.age === undefined) return false;
        const staleDate = DateTime.now().minus(this.age as HumanDuration);
        return DateTime.fromJSDate(pe.processedDate) <= staleDate;
      })
      .map(pe => pe.entityRef);

    const unprocessedEntities = await this.store.getUnprocessedEntities();
    const filteredEntities = unprocessedEntities.concat(staleEntities);

    const entitiesOverview: EntitiesOverview = {
      entityCount: unprocessedEntities.length + processedEntities.length,
      processedCount: processedEntities.length,
      staleCount: staleEntities.length,
      pendingCount: filteredEntities.length,
      filteredEntities: filteredEntities,
    };

    return entitiesOverview;
  }

  /** @internal */
  async generateEntityLanguages(
    entityRef: string,
    url: string,
  ): Promise<string> {
    this.logger?.info(
      `Processing languages for entity ${entityRef} from ${url}`,
    );

    // `dir` is only assigned once the source tree has been fetched. We fetch
    // the tree and run Linguist inside a bounded retry so that transient
    // failures (e.g. a flaky network read) are retried rather than causing the
    // entity to be marked processed and deferred until the next stale window.
    let dir: string | undefined;
    try {
      const results = await this.withRetry(entityRef, async () => {
        // If a previous attempt already materialised a temp directory, remove
        // it before fetching again so retries do not leak directories.
        if (dir) {
          await fs.remove(dir);
          dir = undefined;
        }
        const readTreeResponse = await this.urlReader.readTree(url);
        dir = await readTreeResponse.dir();
        return this.getLinguistResults(dir);
      });

      const totalBytes = results.languages.bytes;
      const langResults = results.languages.results;

      const breakdown: Language[] = [];
      for (const key in langResults) {
        if (Object.prototype.hasOwnProperty.call(langResults, key)) {
          const lang: Language = {
            name: key,
            percentage: +((langResults[key].bytes / totalBytes) * 100).toFixed(
              2,
            ),
            bytes: langResults[key].bytes,
            type: langResults[key].type,
            color: langResults[key].color,
          };
          breakdown.push(lang);
        }
      }

      const languages: Languages = {
        languageCount: results.languages.count,
        totalBytes: totalBytes,
        processedDate: new Date().toISOString(),
        breakdown: breakdown,
      };

      const entityResults: EntityResults = {
        entityRef: entityRef,
        results: languages,
      };

      return await this.store.insertEntityResults(entityResults);
    } catch (error) {
      // All retries were exhausted (or persisting the result failed). Mark the
      // entity processed so a single failing entity does not block the rest of
      // the pending queue indefinitely. Marking is best-effort: if it fails we
      // log and still surface the original error.
      try {
        await this.store.markEntityProcessed(entityRef, new Date());
      } catch (markError) {
        this.logger?.error(
          `Unable to mark "${entityRef}" as processed after failure: ${markError}`,
        );
      }
      throw error;
    } finally {
      // Only clean up when a temporary directory was actually created.
      if (dir) {
        this.logger?.info(`Cleaning up files from ${dir}`);
        await fs.remove(dir);
      }
    }
  }

  /**
   * Runs the given operation, retrying up to `maxRetries` additional times with
   * exponential backoff before giving up. Used to absorb transient failures
   * when fetching and analysing an entity's source tree.
   *
   * @internal
   */
  async withRetry<T>(
    entityRef: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        assertError(error);

        if (attempt < this.maxRetries) {
          const delayMs = this.retryBaseDelayMs * 2 ** attempt;
          this.logger?.warn(
            `Attempt ${attempt + 1} of ${
              this.maxRetries + 1
            } to process "${entityRef}" failed, retrying in ${delayMs}ms: ${
              error.message
            }`,
          );
          await this.delay(delayMs);
        }
      }
    }

    throw lastError;
  }

  /** @internal */
  async delay(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  /** @internal */
  async getLinguistResults(dir: string): Promise<Results> {
    const results = await linguist(dir, { ...this.linguistJsOptions });
    return results;
  }
}

export function kindOrDefault(kind?: string[]): string[] {
  if (!kind || kind.length === 0) {
    return ['API', 'Component', 'Template'];
  }
  return kind;
}
