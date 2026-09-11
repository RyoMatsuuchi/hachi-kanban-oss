// ESLint flat config: TypeScript recommended + 最小限のプロジェクト規約
import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        { allowExpressions: true }
      ]
    }
  },
  {
    ignores: ["**/dist/**", "**/node_modules/**"]
  }
);
