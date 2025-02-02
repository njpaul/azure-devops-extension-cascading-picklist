import {
  CommonServiceIds,
  getClient,
  IProjectPageService,
} from 'azure-devops-extension-api/Common';
import { WorkItemField } from 'azure-devops-extension-api/WorkItemTracking/WorkItemTracking';
import { WorkItemTrackingRestClient } from 'azure-devops-extension-api/WorkItemTracking/WorkItemTrackingClient';
import { IWorkItemFormService } from 'azure-devops-extension-api/WorkItemTracking/WorkItemTrackingServices';
import * as SDK from 'azure-devops-extension-sdk';
import flatten from 'lodash/flatten';
import intersection from 'lodash/intersection';
import uniq from 'lodash/uniq';
import {
  CascadeConfiguration,
  CascadeMap,
  FieldOptions,
  FieldOptionsFlags,
  ICascade,
  RESERVED_FIELD_NAMES,
} from './types';
import { HintService } from './hints.service';

type InvalidField = string;

class CascadingFieldsService {
  private workItemService: IWorkItemFormService;
  private hintService: HintService;
  private cascadeMap: CascadeMap;

  public constructor(
    workItemService: IWorkItemFormService,
    cascadeConfiguration: CascadeConfiguration
  ) {
    this.workItemService = workItemService;
    this.hintService = new HintService(workItemService);
    this.cascadeMap = this.createCascadingMap(cascadeConfiguration);
  }

  private createCascadingMap(cascadeConfiguration: CascadeConfiguration): CascadeMap {
    const cascadeMap: CascadeMap = {};
    if (typeof cascadeConfiguration === 'undefined') {
      return cascadeMap;
    }

    Object.entries(cascadeConfiguration).map(([fieldName, fieldValues]) => {
      let alters: string[] = [];
      Object.values(fieldValues).map(cascadeDefinitions => {
        Object.keys(cascadeDefinitions)
          .filter(field => !RESERVED_FIELD_NAMES.includes(field))
          .map(field => alters.push(field));
      });

      alters = uniq(alters);

      const cascade: ICascade = {
        alters,
        cascades: fieldValues,
      };

      cascadeMap[fieldName] = cascade;
    });
    return cascadeMap;
  }

  private getAffectedFields(fieldReferenceName: string, fieldValue: string): string[] {
    if (!fieldValue) {
      // All dependent field references are affected if the parent has no value
      return uniq(Object.values(this.cascadeMap[fieldReferenceName].cascades)
        .flatMap(cascade => Object.keys(cascade)))
      .filter(k => !RESERVED_FIELD_NAMES.includes(k))
    }

    if (this.cascadeMap[fieldReferenceName].cascades.hasOwnProperty(fieldValue)) {
     return Object.keys(this.cascadeMap[fieldReferenceName].cascades[fieldValue])
      .filter(field => !RESERVED_FIELD_NAMES.includes(field));
    }

    return [];
  }

  private async validateFilter(fieldReferenceName: string): Promise<boolean> {
    const allowedValues: string[] = await (this
      .workItemService as any).getFilteredAllowedFieldValues(fieldReferenceName);
    const fieldValue = (await this.workItemService.getFieldValue(fieldReferenceName)) as string;
    return !fieldValue || allowedValues.includes(fieldValue)
  }

  public async resetAllCascades(): Promise<void[]> {
    // Re-enable the hint service so that we provide hints the next time a
    // work item form is enabled
    this.hintService.setEnabled(true)

    const fields = flatten(Object.values(this.cascadeMap).map(value => value.alters));
    const fieldsToReset = new Set<string>(fields);
    return Promise.all(
      Array.from(fieldsToReset).map(async fieldName => {
        const values = await this.workItemService.getAllowedFieldValues(fieldName);
        await (this.workItemService as any).filterAllowedFieldValues(fieldName, values);
      })
    );
  }

  private async prepareCascadeOptions(affectedFields: string[]): Promise<FieldOptions> {
    const fieldValues: FieldOptions = {};

    await Promise.all(
      flatten(
        affectedFields.map(field => {
          return Object.entries(this.cascadeMap).map(async ([alterField, cascade]) => {
            if (cascade.alters.includes(field)) {
              const fieldValue = (await this.workItemService.getFieldValue(alterField)) as string;
              let cascadeOptions: string[];
              if (
                !fieldValue ||
                ( typeof cascade.cascades[fieldValue]?.[field] === 'string' &&
                  cascade.cascades[fieldValue]?.[field] === FieldOptionsFlags.All )
              ) {
                cascadeOptions = (await this.workItemService.getAllowedFieldValues(field)).map(
                  value => value.toString()
                );
              } else {
                cascadeOptions = cascade.cascades[fieldValue][field] as string[];
              }

              if (fieldValues.hasOwnProperty(field)) {
                fieldValues[field] = intersection(fieldValues[field], cascadeOptions);
              } else {
                fieldValues[field] = cascadeOptions;
              }
            }
          });
        })
      )
    );

    return fieldValues;
  }

  public async cascadeAll(): Promise<void> {
    await Promise.all(
      Object.keys(this.cascadeMap).map(async field => this.performCascading(field))
    );

    // Only hint the first time we're cascading on the form
    this.hintService.setEnabled(false)
  }

  public async performCascading(changedFieldReferenceName: string): Promise<void> {
    const changedFieldValue = (await this.workItemService.getFieldValue(
      changedFieldReferenceName
    )) as string;

    await this.workItemService.clearError();

    if (!this.cascadeMap.hasOwnProperty(changedFieldReferenceName)) {
      return;
    }

    await this.hintService.hintFieldValue(this.cascadeMap, changedFieldReferenceName, changedFieldValue);
    const affectedFields = this.getAffectedFields(changedFieldReferenceName, changedFieldValue);
    const fieldValues = await this.prepareCascadeOptions(affectedFields);

    for (const [fieldReferenceName, values] of Object.entries(fieldValues)) {
      await (this.workItemService as any).filterAllowedFieldValues(fieldReferenceName, values);
      const isValid = await this.validateFilter(fieldReferenceName);
      if (!isValid) {
        await this.workItemService.setError(`Field '${fieldReferenceName}' value is invalid`);
        break;
      }
    }
  }
}

interface ICascadeValidatorError {
  description: string;
}

class CascadeValidationService {
  private cachedFields: WorkItemField[];

  public async validateCascades(cascades: CascadeConfiguration): Promise<null | InvalidField[]> {
    const projectInfoService = await SDK.getService<IProjectPageService>(
      CommonServiceIds.ProjectPageService
    );
    const project = await projectInfoService.getProject();

    if (this.cachedFields == null) {
      const witRestClient = await getClient(WorkItemTrackingRestClient);
      const fields = await witRestClient.getFields(project.id);
      this.cachedFields = fields;
    }
    const fieldList = this.cachedFields.map(field => field.referenceName);

    // Check fields correctness for config root
    let invalidFieldsTotal = Object.keys(cascades).filter(field => !fieldList.includes(field));

    // Check fields on the lower level of config
    Object.values(cascades).map(fieldValues => {
      Object.values(fieldValues).map(innerFields => {
        const invalidFields = Object.keys(innerFields)
          .filter(field => !RESERVED_FIELD_NAMES.includes(field) && !fieldList.includes(field));
        invalidFieldsTotal = [...invalidFieldsTotal, ...invalidFields];
      });
    });

    if (invalidFieldsTotal.length > 0) {
      return invalidFieldsTotal;
    }

    return null;
  }
}

export { CascadingFieldsService, CascadeValidationService, ICascadeValidatorError };
