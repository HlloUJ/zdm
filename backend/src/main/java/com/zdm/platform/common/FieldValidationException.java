package com.zdm.platform.common;

public class FieldValidationException extends IllegalArgumentException {
  private final String field;
  private final String hint;

  public FieldValidationException(String field, String message) {
    this(field, message, null);
  }

  public FieldValidationException(String field, String message, Throwable cause) {
    this(field, message, message, cause);
  }

  private FieldValidationException(String field, String message, String hint, Throwable cause) {
    super(message, cause);
    this.hint = hint;
    this.field = field;
  }

  public static FieldValidationException withHint(String field, String message, String hint) {
    return new FieldValidationException(field, message, hint, null);
  }

  public String hint() { return hint; }
  public String field() { return field; }
}
