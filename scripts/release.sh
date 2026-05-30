#!/usr/bin/env bash
set -euo pipefail

SEMVER_REGEX='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
RELEASE_BRANCH="${RELEASE_BRANCH:-main}"

usage() {
  cat <<'USAGE'
Usage: npm run release -- <version> [--push]

Creates a release commit and annotated semver tag after updating package.json
and package-lock.json with npm version. Use --push to push the commit and tag.

Examples:
  npm run release -- 0.1.2
  npm run release -- v0.1.2 --push
USAGE
}

version="${1:-}"
if [[ "$version" == "-h" || "$version" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "$version" ]]; then
  usage >&2
  exit 1
fi

shift || true
push_after=false
for arg in "$@"; do
  case "$arg" in
    --push)
      push_after=true
      ;;
    *)
      echo "Unknown option: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

version="${version#v}"
tag="v$version"

if [[ ! "$version" =~ $SEMVER_REGEX ]]; then
  echo "Release version must be semver, for example 0.1.2 or 0.1.2-beta.1" >&2
  exit 1
fi

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$RELEASE_BRANCH" ]]; then
  echo "Releases must be created from $RELEASE_BRANCH; current branch is ${current_branch:-detached HEAD}." >&2
  echo "Set RELEASE_BRANCH=<branch> if this repository intentionally releases from a different branch." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree must be clean before creating a release." >&2
  git status --short >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "Local tag $tag already exists." >&2
  exit 1
fi

set +e
git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1
remote_tag_status=$?
set -e

case "$remote_tag_status" in
  0)
    echo "Remote tag $tag already exists on origin." >&2
    exit 1
    ;;
  2)
    ;;
  *)
    echo "Could not check whether $tag exists on origin." >&2
    exit 1
    ;;
esac

npm run format:check
npm run lint
npm run typecheck
npm test

npm version "$version" --no-git-tag-version

package_version="$(node -p "require('./package.json').version")"
lockfile_version="$(node -p "require('./package-lock.json').version")"
lockfile_root_version="$(node -p "require('./package-lock.json').packages[''].version")"

if [[ "$package_version" != "$version" || "$lockfile_version" != "$version" || "$lockfile_root_version" != "$version" ]]; then
  echo "Release version files are inconsistent after npm version:" >&2
  echo "  package.json: $package_version" >&2
  echo "  package-lock.json: $lockfile_version" >&2
  echo "  package-lock root package: $lockfile_root_version" >&2
  exit 1
fi

git add package.json package-lock.json
git commit -m "chore: release $tag" -m "Update package metadata for release $tag."
git tag -a "$tag" -m "$tag"

if [[ "$push_after" == true ]]; then
  git push origin "$current_branch" --follow-tags
else
  echo "Created release commit and tag $tag."
  echo "Next: git push origin $current_branch --follow-tags"
fi
