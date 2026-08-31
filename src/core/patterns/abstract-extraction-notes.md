# Abstract Pattern Extraction Notes (F4)

## How AST interface/method signatures are generalized

1. **Extract interface declarations** from TypeScript source files using the `typescript` compiler API (`ts.createSourceFile`).
2. **Collect `PropertySignature` nodes** (name + type) from interface members, along with `MethodSignature` / `MethodDeclaration` nodes (name + parameter list + return type).
3. **Build `abstractTemplate`** by stripping concrete implementations:
   - Remove class bodies (method implementations, property initializers, constructor bodies).
   - Keep only interface contracts: method names, parameter types, and return types.
4. This produces **language-agnostic templates** that can be reused across projects regardless of concrete implementation language.

## Example

```ts
interface Factory {
  createProduct(type: string): Product;
}
```

Becomes:
- `interfaceName`: `Factory`
- `methodSignatures`: [`createProduct(type: string): Product`]
- `parameters`: [`type: string`]
- `returnType`: `Product`
