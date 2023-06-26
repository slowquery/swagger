import { head } from 'lodash';
import { isAbsolute, posix } from 'path';
import * as ts from 'typescript';
import { PluginOptions } from '../merge-options';
import {
  getDecoratorName,
  getText,
  getTypeArguments,
  isArray,
  isBigInt,
  isBoolean,
  isEnum,
  isInterface,
  isNumber,
  isString,
  isStringLiteral
} from './ast-utils';

export function getDecoratorOrUndefinedByNames(
  names: string[],
  decorators: readonly ts.Decorator[],
  factory: ts.NodeFactory
): ts.Decorator | undefined {
  return (decorators || factory.createNodeArray()).find((item) => {
    try {
      const decoratorName = getDecoratorName(item);
      return names.includes(decoratorName);
    } catch {
      return false;
    }
  });
}

export function getTypeReferenceAsString(
  type: ts.Type,
  typeChecker: ts.TypeChecker,
  arrayDepth = 0
): {
  typeName: string;
  isArray?: boolean;
  arrayDepth?: number;
} {
  if (isArray(type)) {
    const arrayType = getTypeArguments(type)[0];
    const { typeName, arrayDepth: depth } = getTypeReferenceAsString(
      arrayType,
      typeChecker,
      arrayDepth + 1
    );
    if (!typeName) {
      return { typeName: undefined };
    }
    return {
      typeName: `${typeName}`,
      isArray: true,
      arrayDepth: depth
    };
  }
  if (isBoolean(type)) {
    return { typeName: Boolean.name, arrayDepth };
  }
  if (isNumber(type)) {
    return { typeName: Number.name, arrayDepth };
  }
  if (isBigInt(type)) {
    return { typeName: BigInt.name, arrayDepth };
  }
  if (isString(type) || isStringLiteral(type)) {
    return { typeName: String.name, arrayDepth };
  }
  if (isPromiseOrObservable(getText(type, typeChecker))) {
    const typeArguments = getTypeArguments(type);
    const elementType = getTypeReferenceAsString(
      head(typeArguments),
      typeChecker,
      arrayDepth
    );
    return elementType;
  }
  if (type.isClass()) {
    return { typeName: getText(type, typeChecker), arrayDepth };
  }
  try {
    const text = getText(type, typeChecker);
    if (text === Date.name) {
      return { typeName: text, arrayDepth };
    }
    if (isOptionalBoolean(text)) {
      return { typeName: Boolean.name, arrayDepth };
    }
    if (
      isAutoGeneratedTypeUnion(type) ||
      isAutoGeneratedEnumUnion(type, typeChecker)
    ) {
      const types = (type as ts.UnionOrIntersectionType).types;
      return getTypeReferenceAsString(
        types[types.length - 1],
        typeChecker,
        arrayDepth
      );
    }
    if (
      text === 'any' ||
      text === 'unknown' ||
      text === 'object' ||
      isInterface(type) ||
      (type.isUnionOrIntersection() && !isEnum(type))
    ) {
      return { typeName: 'Object', arrayDepth };
    }
    if (isEnum(type)) {
      return { typeName: undefined, arrayDepth };
    }
    if (type.aliasSymbol) {
      return { typeName: 'Object', arrayDepth };
    }
    return { typeName: undefined };
  } catch {
    return { typeName: undefined };
  }
}

export function isPromiseOrObservable(type: string) {
  return type.includes('Promise') || type.includes('Observable');
}

export function hasPropertyKey(
  key: string,
  properties: ts.NodeArray<ts.PropertyAssignment>
): boolean {
  return properties
    .filter((item) => !isDynamicallyAdded(item))
    .some((item) => item.name.getText() === key);
}

export function replaceImportPath(
  typeReference: string,
  fileName: string,
  options: PluginOptions
) {
  if (!typeReference.includes('import')) {
    return { typeReference, importPath: null };
  }
  let importPath = /\(\"([^)]).+(\")/.exec(typeReference)[0];
  if (!importPath) {
    return { typeReference: undefined, importPath: null };
  }
  importPath = convertPath(importPath);
  importPath = importPath.slice(2, importPath.length - 1);

  try {
    if (isAbsolute(importPath)) {
      throw {};
    }
    require.resolve(importPath);
    typeReference = typeReference.replace('import', 'require');
    return {
      typeReference,
      importPath: null
    };
  } catch (_error) {
    const from = options?.readonly
      ? options.pathToSource
      : posix.dirname(convertPath(fileName));

    let relativePath = posix.relative(from, importPath);
    relativePath = relativePath[0] !== '.' ? './' + relativePath : relativePath;

    const nodeModulesText = 'node_modules';
    const nodeModulePos = relativePath.indexOf(nodeModulesText);
    if (nodeModulePos >= 0) {
      relativePath = relativePath.slice(
        nodeModulePos + nodeModulesText.length + 1 // slash
      );

      const typesText = '@types';
      const typesPos = relativePath.indexOf(typesText);
      if (typesPos >= 0) {
        relativePath = relativePath.slice(
          typesPos + typesText.length + 1 //slash
        );
      }

      const indexText = '/index';
      const indexPos = relativePath.indexOf(indexText);
      if (indexPos >= 0) {
        relativePath = relativePath.slice(0, indexPos);
      }
    }

    typeReference = typeReference.replace(importPath, relativePath);

    if (options.readonly) {
      const { typeName, typeImportStatement } =
        convertToAsyncImport(typeReference);
      return {
        typeReference: typeImportStatement,
        typeName,
        importPath: relativePath
      };
    }
    return {
      typeReference: typeReference.replace('import', 'require'),
      importPath: relativePath
    };
  }
}

function convertToAsyncImport(typeReference: string) {
  const regexp = /import\(.+\).([^\]]+)(\])?/;
  const match = regexp.exec(typeReference);

  if (match?.length >= 2) {
    const importPos = typeReference.indexOf(match[0]);
    typeReference = typeReference.replace(`.${match[1]}`, '');

    return {
      typeImportStatement: insertAt(typeReference, importPos, 'await '),
      typeName: match[1]
    };
  }

  return { typeImportStatement: typeReference };
}

export function insertAt(string: string, index: number, substring: string) {
  return string.slice(0, index) + substring + string.slice(index);
}

export function isDynamicallyAdded(identifier: ts.Node) {
  return identifier && !identifier.parent && identifier.pos === -1;
}

/**
 * When "strict" mode enabled, TypeScript transform the enum type to a union composed of
 * the enum values and the undefined type. Hence, we have to lookup all the union types to get the original type
 * @param type
 * @param typeChecker
 */
export function isAutoGeneratedEnumUnion(
  type: ts.Type,
  typeChecker: ts.TypeChecker
): ts.Type {
  if (type.isUnionOrIntersection() && !isEnum(type)) {
    if (!type.types) {
      return undefined;
    }
    const undefinedTypeIndex = type.types.findIndex(
      (type: any) => type.intrinsicName === 'undefined'
    );
    if (undefinedTypeIndex < 0) {
      return undefined;
    }

    // "strict" mode for enums
    let parentType = undefined;
    const isParentSymbolEqual = type.types.every((item, index) => {
      if (index === undefinedTypeIndex) {
        return true;
      }
      if (!item.symbol) {
        return false;
      }
      if (
        !(item.symbol as any).parent ||
        item.symbol.flags !== ts.SymbolFlags.EnumMember
      ) {
        return false;
      }
      const symbolType = typeChecker.getDeclaredTypeOfSymbol(
        (item.symbol as any).parent
      );
      if (symbolType === parentType || !parentType) {
        parentType = symbolType;
        return true;
      }
      return false;
    });
    if (isParentSymbolEqual) {
      return parentType;
    }
  }
  return undefined;
}

/**
 * when "strict" mode enabled, TypeScript transform the type signature of optional properties to
 * the {undefined | T} where T is the original type. Hence, we have to extract the last type of type union
 * @param type
 */
export function isAutoGeneratedTypeUnion(type: ts.Type): boolean {
  if (type.isUnionOrIntersection() && !isEnum(type)) {
    if (!type.types) {
      return false;
    }
    const undefinedTypeIndex = type.types.findIndex(
      (type: any) => type.intrinsicName === 'undefined'
    );

    // "strict" mode for non-enum properties
    if (type.types.length === 2 && undefinedTypeIndex >= 0) {
      return true;
    }
  }
  return false;
}

export function extractTypeArgumentIfArray(type: ts.Type) {
  if (isArray(type)) {
    type = getTypeArguments(type)[0];
    if (!type) {
      return undefined;
    }
    return {
      type,
      isArray: true
    };
  }
  return {
    type,
    isArray: false
  };
}

/**
 * when "strict" mode enabled, TypeScript transform optional boolean properties to "boolean | undefined"
 * @param text
 */
function isOptionalBoolean(text: string) {
  return typeof text === 'string' && text === 'boolean | undefined';
}

/**
 * Converts Windows specific file paths to posix
 * @param windowsPath
 */
export function convertPath(windowsPath: string) {
  return windowsPath
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/')
    .replace(/\/\/+/g, '/');
}
