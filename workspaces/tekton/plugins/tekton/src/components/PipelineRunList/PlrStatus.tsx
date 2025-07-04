/*
 * Copyright 2024 The Backstage Authors
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
  pipelineRunFilterReducer,
  PipelineRunKind,
  Status,
} from '@janus-idp/shared-react';

import './PlrStatus.css';
import { useTranslationRef } from '@backstage/core-plugin-api/alpha';
import { tektonTranslationRef } from '../../translation';

type PlrStatusProps = { obj: PipelineRunKind };

const PlrStatus = ({ obj }: PlrStatusProps) => {
  const plrStatus = pipelineRunFilterReducer(obj);
  const { t } = useTranslationRef(tektonTranslationRef);
  return (
    <Status
      status={plrStatus}
      displayStatusText={t(`pipelineRunStatus.${plrStatus}` as any, {
        defaultValue: plrStatus,
      })}
      className="bs-tkn-plrstatus"
    />
  );
};

export default PlrStatus;
