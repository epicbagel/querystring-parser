const {
  isAnArray,
  containsNoErrorFromParser,
} = require("../helpers/validation");

function parseInclude(include, includeErrors) {
  const parsedArray = [];
  let errors = [];
  if (containsNoErrorFromParser(includeErrors)) {
    if (!isAnArray(include)) {
      errors.push("Include field should be an array");
    } else {
      if (include.length > 0) {
        parsedArray.push({
          fx: "select",
          parameters: include,
        });
      }
    }
  } else {
    errors = includeErrors;
  }
  return {
    results: parsedArray,
    errors,
  };
}

module.exports = parseInclude;
