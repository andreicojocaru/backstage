/*
 * Copyright 2020 The Backstage Authors
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

import { ContainerRunner } from '@backstage/backend-common';
import { Config } from '@backstage/config';
import path from 'path';
import { Logger } from 'winston';
import {
  ScmIntegrationRegistry,
  ScmIntegrations,
} from '@backstage/integration';
import {
  createOrUpdateMetadata,
  getMkdocsYml,
  patchIndexPreBuild,
  patchMkdocsYmlPreBuild,
  runCommand,
  storeEtagMetadata,
  validateMkdocsYaml,
} from './helpers';
import {
  GeneratorBase,
  GeneratorConfig,
  GeneratorRunInType,
  GeneratorRunOptions,
} from './types';
import { ForwardedError } from '@backstage/errors';

export class TechdocsGenerator implements GeneratorBase {
  /**
   * The default docker image (and version) used to generate content. Public
   * and static so that techdocs-common consumers can use the same version.
   */
  public static readonly defaultDockerImage = 'spotify/techdocs:v0.3.7';
  private readonly logger: Logger;
  private readonly containerRunner: ContainerRunner;
  private readonly options: GeneratorConfig;
  private readonly scmIntegrations: ScmIntegrationRegistry;

  static fromConfig(
    config: Config,
    options: { containerRunner: ContainerRunner; logger: Logger },
  ) {
    const { containerRunner, logger } = options;
    const scmIntegrations = ScmIntegrations.fromConfig(config);
    return new TechdocsGenerator({
      logger,
      containerRunner,
      config,
      scmIntegrations,
    });
  }

  constructor(options: {
    logger: Logger;
    containerRunner: ContainerRunner;
    config: Config;
    scmIntegrations: ScmIntegrationRegistry;
  }) {
    this.logger = options.logger;
    this.options = readGeneratorConfig(options.config, options.logger);
    this.containerRunner = options.containerRunner;
    this.scmIntegrations = options.scmIntegrations;
  }

  public async run(options: GeneratorRunOptions): Promise<void> {
    const {
      inputDir,
      outputDir,
      parsedLocationAnnotation,
      etag,
      logger: childLogger,
      logStream,
    } = options;

    // Do some updates to mkdocs.yml before generating docs e.g. adding repo_url
    const { path: mkdocsYmlPath, content } = await getMkdocsYml(inputDir);

    // validate the docs_dir first
    const docsDir = await validateMkdocsYaml(inputDir, content);

    if (parsedLocationAnnotation) {
      await patchMkdocsYmlPreBuild(
        mkdocsYmlPath,
        childLogger,
        parsedLocationAnnotation,
        this.scmIntegrations,
      );
      await patchIndexPreBuild({ inputDir, logger: childLogger, docsDir });
    }

    // Directories to bind on container
    const mountDirs = {
      [inputDir]: '/input',
      [outputDir]: '/output',
    };

    try {
      switch (this.options.runIn) {
        case 'local':
          await runCommand({
            command: 'mkdocs',
            args: ['build', '-d', outputDir, '-v'],
            options: {
              cwd: inputDir,
            },
            logStream,
          });
          childLogger.info(
            `Successfully generated docs from ${inputDir} into ${outputDir} using local mkdocs`,
          );
          break;
        case 'docker':
          await this.containerRunner.runContainer({
            imageName:
              this.options.dockerImage ?? TechdocsGenerator.defaultDockerImage,
            args: ['build', '-d', '/output'],
            logStream,
            mountDirs,
            workingDir: '/input',
            // Set the home directory inside the container as something that applications can
            // write to, otherwise they will just fail trying to write to /
            envVars: { HOME: '/tmp' },
            pullImage: this.options.pullImage,
          });
          childLogger.info(
            `Successfully generated docs from ${inputDir} into ${outputDir} using techdocs-container`,
          );
          break;
        default:
          throw new Error(
            `Invalid config value "${this.options.runIn}" provided in 'techdocs.generators.techdocs'.`,
          );
      }
    } catch (error) {
      this.logger.debug(
        `Failed to generate docs from ${inputDir} into ${outputDir}`,
      );
      throw new ForwardedError(
        `Failed to generate docs from ${inputDir} into ${outputDir}`,
        error,
      );
    }

    /**
     * Post Generate steps
     */

    // Add build timestamp and files to techdocs_metadata.json
    // Creates techdocs_metadata.json if file does not exist.
    await createOrUpdateMetadata(
      path.join(outputDir, 'techdocs_metadata.json'),
      childLogger,
    );

    // Add etag of the prepared tree to techdocs_metadata.json
    // Assumes that the file already exists.
    if (etag) {
      await storeEtagMetadata(
        path.join(outputDir, 'techdocs_metadata.json'),
        etag,
      );
    }
  }
}

export function readGeneratorConfig(
  config: Config,
  logger: Logger,
): GeneratorConfig {
  const legacyGeneratorType = config.getOptionalString(
    'techdocs.generators.techdocs',
  ) as GeneratorRunInType;

  if (legacyGeneratorType) {
    logger.warn(
      `The 'techdocs.generators.techdocs' configuration key is deprecated and will be removed in the future. Please use 'techdocs.generator' instead. ` +
        `See here https://backstage.io/docs/features/techdocs/configuration`,
    );
  }

  return {
    runIn:
      legacyGeneratorType ??
      config.getOptionalString('techdocs.generator.runIn') ??
      'docker',
    dockerImage: config.getOptionalString('techdocs.generator.dockerImage'),
    pullImage: config.getOptionalBoolean('techdocs.generator.pullImage'),
  };
}
