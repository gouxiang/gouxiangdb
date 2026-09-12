-- 知识库模块（与 Base/Table 完全解耦的独立容器）
-- KnowledgeBase / KbMember / KbDoc / KbDocVersion / KbDocAcl

CREATE TABLE "knowledge_bases" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "iconColor" TEXT NOT NULL DEFAULT '#0F6E56',
  "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" DATETIME
);

CREATE TABLE "kb_members" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kbId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "kb_members_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_bases" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "kb_docs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kbId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL DEFAULT '',
  "searchText" TEXT NOT NULL DEFAULT '',
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" DATETIME,
  "deletedBy" TEXT,
  CONSTRAINT "kb_docs_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_bases" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "kb_doc_versions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "docId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "label" TEXT,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "searchText" TEXT NOT NULL DEFAULT '',
  "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "kb_doc_versions_docId_fkey" FOREIGN KEY ("docId") REFERENCES "kb_docs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "kb_doc_acls" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "docId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  CONSTRAINT "kb_doc_acls_docId_fkey" FOREIGN KEY ("docId") REFERENCES "kb_docs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "kb_members_kbId_userId_key" ON "kb_members"("kbId", "userId");
CREATE INDEX "kb_members_userId_idx" ON "kb_members"("userId");
CREATE INDEX "kb_docs_kbId_idx" ON "kb_docs"("kbId");
CREATE INDEX "kb_docs_kbId_kind_idx" ON "kb_docs"("kbId", "kind");
CREATE UNIQUE INDEX "kb_doc_versions_docId_version_key" ON "kb_doc_versions"("docId", "version");
CREATE INDEX "kb_doc_versions_docId_idx" ON "kb_doc_versions"("docId");
CREATE UNIQUE INDEX "kb_doc_acls_docId_userId_key" ON "kb_doc_acls"("docId", "userId");
CREATE INDEX "kb_doc_acls_docId_idx" ON "kb_doc_acls"("docId");
