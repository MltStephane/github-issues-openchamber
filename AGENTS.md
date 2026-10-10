# Consignes agents IA

## Workflow

1. Lire `CONTEXT.md`, `AGENTS.md` et `PERSONAS.md` avant toute modification.
2. Identifier si le changement concerne le panel, le service, un module pur `src/*`, le manifeste ou la documentation.
3. Inspecter uniquement les fichiers nécessaires.
4. Modifier le minimum de code ou de documentation requis.
5. Vérifier avec les commandes adaptées au changement.
6. Ne pas commit, push ou deploy sauf demande explicite.

## Fichiers à inspecter selon le sujet

- UI du panel : `panel/main.ts` (et `panel/index.html` pour la page hôte).
- Service HTTP, routes, appels `gh`/`git` : `service/main.ts`.
- Issue, normalisation, filtre : `src/issue.js`.
- Prompt « Implement » : `src/prompt.js`.
- Message de commit, mots-clés, commentaire : `src/commit.js`.
- Lecture de `git status` : `src/changes.js`.
- Manifeste et permissions : `package.json` (`openchamber.contributes`).
- Tests : `tests/*.test.js`.
- Documentation utilisateur : `README.md`.

## Commandes

Depuis la racine du package :

```bash
bun run build
bun run test
bun run check
```

- Toute modification de `panel/main.ts` ou `service/main.ts` doit être suivie de `bun run build` : les bundles sont committés.
- `bun run check` est la validation de référence (syntax check + tests).

## Restrictions

- Ne pas commit, push ou deploy sans instruction explicite.
- Ne pas modifier des fichiers hors-scope.
- Ne pas ajouter de modal sauf demande explicite.
- Ne pas introduire de dépendance ni de refactor hors-scope sans justification.
- Ne pas élargir les permissions du manifeste (`exec` au-delà de `gh` et `git`, `sockets`, `filesystem`, `integration`, autres `capabilities`) sans demande explicite.
- Ne pas inventer de fonctionnalité produit non demandée.

## Invariants à préserver

- **`execFile` sans shell** : arguments en tableau, jamais de chaîne interpolée, jamais `shell: true`. Le texte libre (message, commentaire) passe par stdin.
- **Validation du dossier** : `directory` absolu, sans NUL, existant, de type dossier ; sinon 400.
- **Commit puis commentaire** : le commentaire n'est posté qu'après un commit réussi ; son échec renvoie 200 avec `commentError` et ne touche pas au commit.
- **Aucun prompt interactif** : `GH_PROMPT_DISABLED=1`, `GIT_TERMINAL_PROMPT=0`, stdin fermé quand il n'y a pas d'entrée.
- **Auth service** : bind `127.0.0.1`, jeton Bearer obligatoire, 401/404/405 explicites, 500 propre sans crash.
- **Mots-clés de fermeture** définis une seule fois dans `src/commit.js` (`CLOSING_KEYWORDS`).
- **Une erreur réseau n'efface pas la liste affichée** : passer par `setStatus`.

## Pièges connus

- Le panel n'est pas couvert par les tests unitaires : tout changement d'UI se vérifie avec un hôte simulé.
- Ne jamais mettre un champ en cours de frappe (sujet, commentaire, recherche) dans la signature d'un `Block` : le repaint casse le focus.
- Le host abandonne une requête après 20 s (`GUEST_REQUEST_TIMEOUT_MS`) alors qu'un `git commit` avec hooks peut durer jusqu'à 120 s : le panneau affiche alors un message invitant à vérifier Git, le commit peut quand même aboutir.
- `gh` choisit le dépôt d'après les remotes du dossier : un fork aux issues désactivées répond 502 (« repository has disabled issues »).
- Tests réels : toujours envoyer un commentaire vide, pour ne jamais écrire sur GitHub.
