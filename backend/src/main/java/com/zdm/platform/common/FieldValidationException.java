package com.zdm.platform.common;

public class FieldValidationException extends IllegalArgumentException {
  private final String field;

  public FieldValidationException(String field, String message, Throwable cause) {
    super(message, cause);
    this.field = field;
  }

  public String field() { return field; }
}
