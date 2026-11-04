import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const sourceRoot = path.resolve('src')
const sourceExtensions = new Set(['.ts', '.tsx'])
const allowedDependencies = {
  app: new Set(['app', 'pages', 'features', 'shared']),
  pages: new Set(['pages', 'features', 'shared']),
  features: new Set(['features', 'shared']),
  shared: new Set(['shared']),
  test: new Set(['test', 'shared']),
}

async function findSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name)

      if (entry.isDirectory()) {
        return findSourceFiles(entryPath)
      }

      return sourceExtensions.has(path.extname(entry.name)) ? [entryPath] : []
    }),
  )

  return nestedFiles.flat()
}

function getImports(source) {
  const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

  return [...source.matchAll(importPattern)].map((match) => match[1] ?? match[2])
}

function validateImport(file, specifier) {
  const relativeFile = path.relative(sourceRoot, file).replaceAll('\\', '/')

  if (specifier.startsWith('../')) {
    return `${relativeFile}: use o alias @ para imports que saem da pasta atual (${specifier})`
  }

  if (!specifier.startsWith('@/')) {
    return null
  }

  const sourceLayer = relativeFile.split('/')[0]
  const [, targetLayer, targetModule, ...deepPath] = specifier.split('/')
  const allowedTargets = allowedDependencies[sourceLayer]

  if (allowedTargets && !allowedTargets.has(targetLayer)) {
    return `${relativeFile}: a camada ${sourceLayer} não pode importar ${targetLayer} (${specifier})`
  }

  const crossesLayer = sourceLayer !== targetLayer
  const isStyleOrAsset = deepPath.some((part) => part.includes('.'))

  if (crossesLayer && targetModule && deepPath.length > 0 && !isStyleOrAsset) {
    return `${relativeFile}: importe pela API pública de ${targetLayer}/${targetModule} (${specifier})`
  }

  return null
}

function validateDependencyDeclarations(packageJson) {
  const production = new Set(Object.keys(packageJson.dependencies ?? {}))
  const development = new Set(Object.keys(packageJson.devDependencies ?? {}))

  return [...production]
    .filter((dependency) => development.has(dependency))
    .map(
      (dependency) =>
        `package.json: ${dependency} está repetida em dependencies e devDependencies`,
    )
}

const files = await findSourceFiles(sourceRoot)
const sourceErrors = (
  await Promise.all(
    files.map(async (file) => {
      const source = await readFile(file, 'utf8')
      return getImports(source)
        .map((specifier) => validateImport(file, specifier))
        .filter(Boolean)
    }),
  )
).flat()
const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'))
const errors = [
  ...sourceErrors,
  ...validateDependencyDeclarations(packageJson),
]

if (errors.length > 0) {
  console.error(['Fronteiras modulares inválidas:', ...errors].join('\n- '))
  process.exitCode = 1
} else {
  console.log('Imports modulares e dependências declaradas estão consistentes.')
}
