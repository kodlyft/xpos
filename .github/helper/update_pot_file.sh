#!/bin/bash
set -e
cd ~ || exit

echo "Setting Up Bench..."

pip install frappe-bench
bench -v init frappe-bench --skip-assets --skip-redis-config-generation --python "$(which python)" --frappe-branch version-16
cd ./frappe-bench || exit
bench get-app --branch version-16 --skip-assets erpnext
bench get-app --skip-assets xpos "${GITHUB_WORKSPACE}"

echo "Generating POT file..."
bench generate-pot-file --app xpos

cd ./apps/xpos || exit

if git diff --quiet -I '^"(POT-Creation-Date|PO-Revision-Date):' -- xpos/locale/main.pot; then
	echo "POT file is up to date, nothing to do."
	exit 0
fi

echo "Configuring git user..."
git config user.email "ar.frappe.dev@gmail.com"
git config user.name "POS Bot"

echo "Setting the correct git remote..."
# Here, the git remote is a local file path by default. Let's change it to the upstream repo.
git remote set-url upstream "https://github.com/${GITHUB_REPOSITORY}.git"

echo "Creating a new branch..."
isodate=$(date -u +"%Y-%m-%d")
branch_name="pot_${BASE_BRANCH}_${isodate}"
git checkout -b "${branch_name}"

echo "Commiting changes..."
git add xpos/locale/main.pot
git commit -m "chore: update POT file"

gh auth setup-git
git push -u upstream "${branch_name}"

echo "Creating a PR..."
gh pr create --fill --base "${BASE_BRANCH}" --head "${branch_name}" -R "${GITHUB_REPOSITORY}"
