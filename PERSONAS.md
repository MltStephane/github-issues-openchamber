# Personas

## Mainteneur / reviewer

### Besoins

- Comprendre rapidement l'intention d'un changement.
- Préserver un panneau simple et un service borné.
- Vérifier que les invariants tiennent : `execFile` sans shell, validation du dossier, ordre commit puis commentaire, auth service.

### Critères de succès

- Changements limités au périmètre demandé, sans refactor ni dépendance non justifiée.
- `bun run check` passe et les bundles sont rebuildés quand `panel/main.ts` ou `service/main.ts` change.
- Service vérifié en conditions réelles, sans aucune écriture sur GitHub pendant les tests.
- Rendu du panel vérifié avec un hôte simulé.

## Utilisateur développeur (OpenChamber)

### Besoins

- Voir les issues du projet sans quitter OpenChamber.
- Confier une issue à un agent en un clic, dans la session courante ou une nouvelle.
- Committer la correction avec la bonne référence à l'issue, sans retenir la syntaxe GitHub.

### Critères de succès

- Liste lisible en panneau étroit, filtrable, sans perte de focus.
- Le commit contient `Closes #N` (ou `Fixes`/`Resolves`) et l'issue se ferme à l'arrivée sur la branche par défaut.
- Sur une branche secondaire, le commentaire proposé explique que l'issue se fermera au merge.
- Un commentaire en échec n'annule jamais le commit.

## Intégrateur OpenChamber (hôte / SDK)

### Besoins

- Un manifeste installable (apiVersion 1, panel + service déclarés, version semver).
- Des permissions minimales et explicites : capabilities `prompt` et `sessions`, service `exec: ["gh", "git"]`, sans `sockets`, `filesystem` ni intégration.
- Un service borné : bind local, jeton obligatoire, timeouts et `maxBuffer` sur chaque commande.
- Des bundles stables et committés.

### Critères de succès

- Installation via Settings → Extensions sans configuration cachée.
- Permissions lisibles et justifiées dans le dialogue d'approbation.
- Le service ne peut pas bloquer ni faire tomber l'hôte (réponse 500 propre, jamais de crash, aucun prompt interactif).
