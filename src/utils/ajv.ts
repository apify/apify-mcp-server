import Ajv from 'ajv';

export const ajv = new Ajv({ coerceTypes: 'array', strict: false });
