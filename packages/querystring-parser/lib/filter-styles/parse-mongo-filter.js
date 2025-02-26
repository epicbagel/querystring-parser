const qs = require("qs");
const areMongoTypesTheSame = require("../helpers/are-mongo-types-the-same");
const isNullString = require("../helpers/is-null-string");
const MongoOperator = require("../enums/mongo-operator");
const SqlOperator = require("../enums/sql-operator");
const MongoValueType = require("../enums/mongo-value-type");
const QuerystringParsingError = require("../../lib/errors/querystring-parsing-error");

/** Parses "MongoDB-style" filters from of a querystring. */
function parseMongoFilter(querystring) {
  const errors = [];
  let results;

  // perform initial parse with qs lib
  const qsParams = qs.parse(querystring, { depth: 0, comma: true });
  const filterParams = Object.entries(qsParams).filter(([key]) =>
    key.startsWith("filter")
  );

  const fieldResults = [];
  for (let [param, providedValue] of filterParams) {
    /************************************************************************
     * 1. Identify field, operator, and value(s) represented as plain strings
     ************************************************************************/
    let [, field, providedOperator = undefined] = param
      .replace(/\[/g, "]") // String.prototype.replaceAll() not supported until node v15.0.0
      .split("]")
      .filter((s) => s.length);

    const operatorWasOmitted = providedOperator === undefined;
    const providedValueWasAnArray = Array.isArray(providedValue);

    // helper: error constructor with pre-configured data for this field
    const createError = (message) => {
      return new QuerystringParsingError({
        message,
        querystring,
        paramKey: `filter[${field}]${
          operatorWasOmitted ? "" : "[" + providedOperator + "]"
        }`,
        paramValue: providedValue,
      });
    };

    /************************************************************************
     * 2. Apply defaults and type coersion
     ************************************************************************/
    // temp wrap single values in array so the logic works the same either way
    let operator = providedOperator;
    let values = providedValueWasAnArray ? providedValue : [providedValue];

    // verify all values are the same type (or null)
    const valueType = areMongoTypesTheSame(values);
    if (!valueType) {
      errors.push(createError("arrays should not mix multiple value types"));
      return { results, errors }; // short circuit
    }

    // coerce values
    values = values.map((value) => {
      if (isNullString(value)) {
        return null;
      } else if (valueType === MongoValueType.NUMBER) {
        return Number(value);
      } else {
        return value;
      }
    });

    // determine mongo operator
    if (operatorWasOmitted) {
      if (providedValueWasAnArray) {
        operator = MongoOperator.IN;
      } else {
        switch (valueType) {
          case MongoValueType.NUMBER:
          case MongoValueType.DATE:
            operator = MongoOperator.EQUALS;
            break;
          case MongoValueType.NULL:
            operator = MongoOperator.IS_NULL;
            break;
          case MongoValueType.STRING:
          default:
            operator = MongoOperator.ILIKE;
            break;
        }
      }
    }

    /************************************************************************
     * 3. Check for errors
     ************************************************************************/
    // array compatability check
    if (
      providedValueWasAnArray &&
      ![MongoOperator.IN, MongoOperator.NOT_IN].includes(operator)
    ) {
      errors.push(
        createError(
          `"${operator}" operator should not be used with array value`
        )
      );
      return { results, errors }; // short circuit
    }

    // null compatability check
    if (
      valueType === MongoValueType.NULL &&
      [
        MongoOperator.GREATER_THAN,
        MongoOperator.GREATER_OR_EQUAL,
        MongoOperator.LESS_THAN,
        MongoOperator.LESS_OR_EQUAL,
        MongoOperator.ILIKE,
      ].includes(operator)
    ) {
      errors.push(
        createError(`"${operator}" operator should not be used with null value`)
      );
      return { results, errors }; // short circuit
    }

    // number compatability check
    if (
      valueType === MongoValueType.NUMBER &&
      operator === MongoOperator.ILIKE
    ) {
      errors.push(
        createError(
          `"${operator}" operator should not be used with number values`
        )
      );
      return { results, errors }; // short circuit
    }

    // date compatability check
    if (valueType === MongoValueType.DATE && operator === MongoOperator.ILIKE) {
      errors.push(
        createError(
          `"${operator}" operator should not be used with date values`
        )
      );
      return { results, errors }; // short circuit
    }

    /************************************************************************
     * 4. Map MongoDB-style operators and values to the SQL domain
     ************************************************************************/

    let sqlOperator = {
      [MongoOperator.EQUALS]: SqlOperator.EQUALS,
      [MongoOperator.IS_NULL]: SqlOperator.EQUALS,
      [MongoOperator.NOT_EQUALS]: SqlOperator.NOT_EQUALS,
      [MongoOperator.GREATER_THAN]: SqlOperator.GREATER_THAN,
      [MongoOperator.GREATER_OR_EQUAL]: SqlOperator.GREATER_OR_EQUAL,
      [MongoOperator.LESS_THAN]: SqlOperator.LESS_THAN,
      [MongoOperator.LESS_OR_EQUAL]: SqlOperator.LESS_OR_EQUAL,
      [MongoOperator.ILIKE]: SqlOperator.ILIKE,
      [MongoOperator.IN]: SqlOperator.IN,
      [MongoOperator.NOT_IN]: SqlOperator.NOT_IN,
    }[operator];

    // adjust EQUALS and NOT EQUALS operators for null values
    if (
      [SqlOperator.EQUALS, SqlOperator.NOT_EQUALS].includes(sqlOperator) &&
      valueType === MongoValueType.NULL
    ) {
      sqlOperator = {
        [SqlOperator.EQUALS]: SqlOperator.IS_NULL,
        [SqlOperator.NOT_EQUALS]: SqlOperator.IS_NOT_NULL,
      }[sqlOperator];
    }

    // wrap ilike strings in wildcards
    const sqlValues = values.map((val) => {
      return sqlOperator === SqlOperator.LIKE ? `%${val}%` : val;
    });

    // format like json-logic
    const attributeRef = `#${field}`;
    const operatorIsUnary = [
      SqlOperator.IS_NULL,
      SqlOperator.IS_NOT_NULL,
    ].includes(sqlOperator)
      ? true
      : false;

    if (operatorIsUnary) {
      fieldResults.push({ [sqlOperator]: attributeRef });
    } else {
      fieldResults.push({ [sqlOperator]: [attributeRef, ...sqlValues] });
    }
  }

  // multiple filters get 'AND'-ed together into a compound filter
  results = fieldResults.reduce((prevs, curnt) => {
    return { AND: [prevs, curnt] };
  });

  return { results, errors };
}

module.exports = parseMongoFilter;
