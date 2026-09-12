-- AlterTable
ALTER TABLE "fields" ADD COLUMN "displayedFieldIds" TEXT;
ALTER TABLE "fields" ADD COLUMN "tabsConfig" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_kb_doc_acls" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "docId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    CONSTRAINT "kb_doc_acls_docId_fkey" FOREIGN KEY ("docId") REFERENCES "kb_docs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "kb_doc_acls_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_kb_doc_acls" ("docId", "id", "role", "userId") SELECT "docId", "id", "role", "userId" FROM "kb_doc_acls";
DROP TABLE "kb_doc_acls";
ALTER TABLE "new_kb_doc_acls" RENAME TO "kb_doc_acls";
CREATE INDEX "kb_doc_acls_docId_idx" ON "kb_doc_acls"("docId");
CREATE UNIQUE INDEX "kb_doc_acls_docId_userId_key" ON "kb_doc_acls"("docId", "userId");
CREATE TABLE "new_kb_docs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kbId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "searchText" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "deletedBy" TEXT,
    "parentId" TEXT,
    "shareEnabled" BOOLEAN NOT NULL DEFAULT false,
    "shareToken" TEXT,
    "shareRole" TEXT NOT NULL DEFAULT 'viewer',
    "shareIncludeChildren" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "kb_docs_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_bases" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_kb_docs" ("content", "createdAt", "createdBy", "deletedAt", "deletedBy", "id", "kbId", "kind", "searchText", "title", "updatedAt", "updatedBy") SELECT "content", "createdAt", "createdBy", "deletedAt", "deletedBy", "id", "kbId", "kind", "searchText", "title", "updatedAt", "updatedBy" FROM "kb_docs";
DROP TABLE "kb_docs";
ALTER TABLE "new_kb_docs" RENAME TO "kb_docs";
CREATE UNIQUE INDEX "kb_docs_shareToken_key" ON "kb_docs"("shareToken");
CREATE INDEX "kb_docs_kbId_idx" ON "kb_docs"("kbId");
CREATE INDEX "kb_docs_kbId_kind_idx" ON "kb_docs"("kbId", "kind");
CREATE INDEX "kb_docs_kbId_parentId_idx" ON "kb_docs"("kbId", "parentId");
CREATE INDEX "kb_docs_shareToken_idx" ON "kb_docs"("shareToken");
CREATE TABLE "new_kb_members" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kbId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "kb_members_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_bases" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "kb_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_kb_members" ("id", "joinedAt", "kbId", "role", "userId") SELECT "id", "joinedAt", "kbId", "role", "userId" FROM "kb_members";
DROP TABLE "kb_members";
ALTER TABLE "new_kb_members" RENAME TO "kb_members";
CREATE INDEX "kb_members_userId_idx" ON "kb_members"("userId");
CREATE UNIQUE INDEX "kb_members_kbId_userId_key" ON "kb_members"("kbId", "userId");
CREATE TABLE "new_knowledge_bases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "iconColor" TEXT NOT NULL DEFAULT '#0F6E56',
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);
INSERT INTO "new_knowledge_bases" ("createdAt", "createdBy", "deletedAt", "iconColor", "id", "name", "updatedAt") SELECT "createdAt", "createdBy", "deletedAt", "iconColor", "id", "name", "updatedAt" FROM "knowledge_bases";
DROP TABLE "knowledge_bases";
ALTER TABLE "new_knowledge_bases" RENAME TO "knowledge_bases";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
