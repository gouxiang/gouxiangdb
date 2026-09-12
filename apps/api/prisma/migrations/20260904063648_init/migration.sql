-- CreateTable
CREATE TABLE "bases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "iconColor" TEXT NOT NULL DEFAULT '#378ADD',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "tables" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "baseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primaryFieldId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "tables_baseId_fkey" FOREIGN KEY ("baseId") REFERENCES "bases" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "fields" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tableId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "order" INTEGER NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "unique" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" DATETIME,
    "options" TEXT,
    "precision" INTEGER,
    "linkFieldId" TEXT,
    "relatedTableId" TEXT,
    "relationKind" TEXT,
    "isReverse" BOOLEAN NOT NULL DEFAULT false,
    "reverseFieldId" TEXT,
    "linkDisplayFieldId" TEXT,
    "lookupFieldId" TEXT,
    "rollupFunction" TEXT,
    "formula" TEXT,
    CONSTRAINT "fields_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tableId" TEXT NOT NULL,
    "fields" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "records_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "link_rows" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "linkFieldId" TEXT NOT NULL,
    "parentRowId" TEXT NOT NULL,
    "childRowId" TEXT NOT NULL,
    "ord" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "link_rows_parentRowId_fkey" FOREIGN KEY ("parentRowId") REFERENCES "records" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "link_rows_childRowId_fkey" FOREIGN KEY ("childRowId") REFERENCES "records" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "views" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tableId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "lockMode" TEXT NOT NULL DEFAULT 'collaborative',
    "order" INTEGER NOT NULL,
    "config" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "views_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "members" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "baseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "members_baseId_fkey" FOREIGN KEY ("baseId") REFERENCES "bases" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "comments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "baseId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "tables_baseId_idx" ON "tables"("baseId");

-- CreateIndex
CREATE INDEX "fields_tableId_idx" ON "fields"("tableId");

-- CreateIndex
CREATE INDEX "fields_linkFieldId_idx" ON "fields"("linkFieldId");

-- CreateIndex
CREATE INDEX "fields_reverseFieldId_idx" ON "fields"("reverseFieldId");

-- CreateIndex
CREATE INDEX "records_tableId_idx" ON "records"("tableId");

-- CreateIndex
CREATE INDEX "records_createdAt_idx" ON "records"("createdAt");

-- CreateIndex
CREATE INDEX "link_rows_linkFieldId_parentRowId_idx" ON "link_rows"("linkFieldId", "parentRowId");

-- CreateIndex
CREATE INDEX "link_rows_linkFieldId_childRowId_idx" ON "link_rows"("linkFieldId", "childRowId");

-- CreateIndex
CREATE UNIQUE INDEX "link_rows_linkFieldId_parentRowId_childRowId_key" ON "link_rows"("linkFieldId", "parentRowId", "childRowId");

-- CreateIndex
CREATE INDEX "views_tableId_idx" ON "views"("tableId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "members_userId_idx" ON "members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "members_baseId_userId_key" ON "members"("baseId", "userId");

-- CreateIndex
CREATE INDEX "comments_recordId_idx" ON "comments"("recordId");
