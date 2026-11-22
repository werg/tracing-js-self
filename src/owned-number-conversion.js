import {createPrimitiveConversion,advancePrimitiveConversion} from './owned-primitive-conversion.js';

export const createNumberConversion=(input,siteId)=>createPrimitiveConversion('Number',input,siteId);
export const advanceNumberConversion=advancePrimitiveConversion;
